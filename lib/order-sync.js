// Motor de sincronizare periodica: aduce comenzi din MerchantPro si le
// salveaza/actualizeaza in baza de date locala.
//
// MULTI-COMPANIE: sincronizarea din fundal (startBackgroundSync) ruleaza
// FARA context de agent logat, deci parcurge TOATE companiile care au
// MerchantPro configurat, una cate una. Sincronizarea manuala (butonul
// "Sincronizeaza acum" din interfata) ruleaza doar pentru compania curenta
// (runSyncForCompany).
//
// Strategie (fara acces confirmat la webhook-uri MerchantPro), per companie:
//   1. Comenzi NOI: se extrag toate comenzile create in ultimele
//      SYNC_LOOKBACK_HOURS ore (implicit 72h) -- acopera si eventuale
//      intreruperi temporare ale sincronizarii.
//   2. Comenzi active mai VECHI: orice comanda locala care inca nu e
//      livrata/anulata/returnata e re-verificata la fiecare ciclu, ca sa
//      prindem schimbari de status facute in MerchantPro (ex: platit,
//      expediat) chiar daca a fost creata cu mult timp in urma.

const mp = require('./merchantpro');
const gomag = require('./gomag');
const db = require('./db');

const SYNC_LOOKBACK_HOURS = Number(process.env.MERCHANTPRO_SYNC_LOOKBACK_HOURS || 72);
const TERMINAL_SHIPPING_STATUSES = ['delivered', 'cancelled', 'returned'];

// Cat de departe in urma re-verificam comenzile inca active. O comanda ramasa
// "in procesare" de acum doi ani nu se mai misca -- e o comanda uitata, nu una
// vie. Fara aceasta limita, un magazin cu istoric mare ar re-interoga zeci de
// mii de comenzi moarte la fiecare doua minute.
const ACTIVE_RECHECK_DAYS = Number(process.env.MERCHANTPRO_ACTIVE_RECHECK_DAYS || 120);
// Plafon dur pe ciclu: chiar si in cel mai rau caz, un ciclu de sincronizare
// ramane marginit ca timp si memorie.
const ACTIVE_RECHECK_MAX = Number(process.env.MERCHANTPRO_ACTIVE_RECHECK_MAX || 3000);

/**
 * Detecteaza o comanda cu plata prin card incercata, dar neterminata
 * (ex: card abandonat inainte de finalizare, esuata, in asteptare de
 * confirmare). Aceste comenzi nu sunt preluate in sistemul nostru --
 * doar plata cu card FINALIZATA (paid) e retinuta. Alte metode (ex:
 * ramburs) raman neafectate, indiferent de paymentStatus.
 */
function isIncompleteCardPayment(mpOrder) {
  const name = mpOrder.payment_method_name || '';
  const code = mpOrder.payment_method_code || '';
  const isCardMethod = /card/i.test(name) || /card/i.test(code);
  return isCardMethod && mpOrder.payment_status !== 'paid';
}

/**
 * Salveaza un set de comenzi in loturi, fiecare lot intr-o singura tranzactie.
 * Fara gruparea asta, fiecare comanda e propria tranzactie, cu propriul fsync
 * pe disc -- de zeci de ori mai lent la volume mari.
 */
const UPSERT_BATCH_SIZE = 200;
function upsertBatch(companyId, mpOrders) {
  let created = 0;
  let updated = 0;
  let skippedIncompleteCard = 0;
  for (let i = 0; i < mpOrders.length; i += UPSERT_BATCH_SIZE) {
    const slice = mpOrders.slice(i, i + UPSERT_BATCH_SIZE);
    db.runInTransaction(() => {
      for (const mpOrder of slice) {
        if (isIncompleteCardPayment(mpOrder)) { skippedIncompleteCard += 1; continue; }
        const { isNew } = db.upsertOrderFromMerchantPro(companyId, mpOrder);
        if (isNew) created += 1; else updated += 1;
      }
    });
  }
  return { created, updated, skippedIncompleteCard };
}

let syncing = false; // lacat global -- garanteaza ca nu ruleaza doua cicluri complete simultan
const lastSyncResultByCompany = {}; // companyId -> rezultat ultima sincronizare
const lastSyncErrorByCompany = {}; // companyId -> mesaj eroare ultima sincronizare

/** Sincronizeaza comenzile UNEI SINGURE companii. Folosita atat de sincronizarea din fundal, cat si de butonul manual. */
async function runSyncForCompany(company) {
  if (!mp.isConfigured(company)) {
    const reason = 'Integrarea MerchantPro nu este configurată pentru această companie.';
    lastSyncErrorByCompany[company.id] = reason;
    return { skipped: true, reason };
  }

  const startedAt = Date.now();
  let created = 0;
  let updated = 0;
  let skippedIncompleteCard = 0;

  try {
    // 1. comenzi noi / recente
    const sinceISO = new Date(Date.now() - SYNC_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recent = await mp.listAllOrders(company, { created_after: sinceISO, sort: 'date_created.desc' });
    const recentStats = upsertBatch(company.id, recent);
    created += recentStats.created;
    updated += recentStats.updated;
    skippedIncompleteCard += recentStats.skippedIncompleteCard;

    // 2. comenzi locale inca active, dar mai vechi decat fereastra de mai sus.
    // Cerem bazei DOAR numerele de comanda, nu randurile intregi -- altfel, la
    // un magazin cu sute de mii de comenzi, aici s-ar incarca sute de MB.
    const recheckSinceISO = new Date(Date.now() - ACTIVE_RECHECK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const activeMpIds = db.listOrderMpIdsToRefresh(company.id, {
      shippingStatusNotIn: TERMINAL_SHIPPING_STATUSES,
      sinceISO: recheckSinceISO,
      limit: ACTIVE_RECHECK_MAX,
    });
    const recentIds = new Set(recent.map((o) => o.id));
    const staleActiveIds = activeMpIds.filter((id) => !recentIds.has(id));
    for (let i = 0; i < staleActiveIds.length; i += 50) {
      const batch = staleActiveIds.slice(i, i + 50);
      if (!batch.length) continue;
      const page = await mp.listOrders(company, { ids: batch.join(','), limit: 100 });
      const pageOrders = page.data || [];
      db.runInTransaction(() => {
        for (const mpOrder of pageOrders) {
          if (isIncompleteCardPayment(mpOrder)) {
            skippedIncompleteCard += 1;
            db.deleteOrderByMpId(company.id, mpOrder.id);
            continue;
          }
          const { isNew } = db.upsertOrderFromMerchantPro(company.id, mpOrder);
          if (isNew) created += 1; else updated += 1;
        }
      });
    }

    const result = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      created,
      updated,
      skippedIncompleteCard,
      totalChecked: recent.length + staleActiveIds.length,
    };
    lastSyncResultByCompany[company.id] = result;
    lastSyncErrorByCompany[company.id] = null;
    return result;
  } catch (e) {
    lastSyncErrorByCompany[company.id] = e.message;
    throw e;
  }
}

/**
 * Sincronizeaza comenzile GoMag ale UNEI SINGURE companii. Strategie mai
 * simpla decat la MerchantPro -- re-preluam TOATE comenzile la fiecare
 * ciclu (nu doar cele recente), pentru ca inca nu avem confirmata filtrarea
 * pe interval de data la API-ul GoMag. Sigur, dar mai putin eficient la
 * volume mari -- de optimizat ulterior, odata ce confirmam parametrul corect.
 */
async function runGomagSyncForCompany(company) {
  if (!gomag.isConfigured(company)) {
    return { skipped: true, reason: 'Integrarea GoMag nu este configurată pentru această companie.' };
  }
  const startedAt = Date.now();
  let created = 0;
  let updated = 0;
  try {
    // catalogul de produse (pentru imagini) se preia O SINGURA DATA per
    // ciclu de sincronizare, nu per comanda -- evitam sute de cereri
    // separate si respectam limita de rata GoMag
    let imageBySku = {};
    try {
      const products = await gomag.listAllProducts(company);
      for (const p of products) {
        if (p.sku && Array.isArray(p.images) && p.images.length) imageBySku[p.sku] = p.images[0];
      }
    } catch (e) {
      // daca preluarea catalogului esueaza, continuam fara imagini -- nu
      // blocam sincronizarea comenzilor propriu-zise pentru atat
    }

    const orders = await gomag.listAllOrders(company);
    for (const gmOrder of orders) {
      if (Array.isArray(gmOrder.items)) {
        for (const item of gmOrder.items) {
          if (item.sku && imageBySku[item.sku]) item.product_image_url = imageBySku[item.sku];
        }
      }
      const { isNew } = db.upsertOrderFromGomag(company.id, gmOrder);
      if (isNew) created += 1; else updated += 1;
    }
    const result = { at: new Date().toISOString(), durationMs: Date.now() - startedAt, created, updated, totalChecked: orders.length };
    lastSyncResultByCompany[`${company.id}:gomag`] = result;
    lastSyncErrorByCompany[`${company.id}:gomag`] = null;
    return result;
  } catch (e) {
    lastSyncErrorByCompany[`${company.id}:gomag`] = e.message;
    throw e;
  }
}

/** Sincronizeaza TOATE companiile care au MerchantPro configurat. Folosita de sincronizarea din fundal. */
async function runSync() {
  if (syncing) return { skipped: true, reason: 'Sincronizare deja în curs.' };
  syncing = true;
  try {
    const allCompanies = db.listAllCompanies();
    const mpCompanies = allCompanies.filter((c) => mp.isConfigured(c));
    const gomagCompanies = allCompanies.filter((c) => gomag.isConfigured(c));
    const results = {};
    for (const company of mpCompanies) {
      try {
        results[company.id] = await runSyncForCompany(company);
      } catch (e) {
        results[company.id] = { error: e.message };
      }
    }
    for (const company of gomagCompanies) {
      try {
        results[`${company.id}:gomag`] = await runGomagSyncForCompany(company);
      } catch (e) {
        results[`${company.id}:gomag`] = { error: e.message };
      }
    }
    return { companiesSynced: mpCompanies.length + gomagCompanies.length, results };
  } finally {
    syncing = false;
  }
}

/** Statusul sincronizarii pentru O SINGURA companie (folosit de interfata). */
function getSyncStatus(company) {
  return {
    syncing,
    lastSyncResult: lastSyncResultByCompany[company.id] || null,
    lastSyncError: lastSyncErrorByCompany[company.id] || null,
    configured: mp.isConfigured(company),
    gomag: {
      lastSyncResult: lastSyncResultByCompany[`${company.id}:gomag`] || null,
      lastSyncError: lastSyncErrorByCompany[`${company.id}:gomag`] || null,
      configured: gomag.isConfigured(company),
    },
  };
}

let intervalHandle = null;
function startBackgroundSync(intervalMs) {
  if (intervalHandle) return;
  console.log(`Sincronizare MerchantPro din fundal activă, la fiecare ${Math.round(intervalMs / 1000)}s (toate companiile configurate).`);
  runSync().catch((e) => console.error('Eroare la sincronizarea inițială MerchantPro:', e.message));
  intervalHandle = setInterval(() => {
    runSync().catch((e) => console.error('Eroare la sincronizarea MerchantPro:', e.message));
  }, intervalMs);
}

module.exports = { runSync, runSyncForCompany, runGomagSyncForCompany, getSyncStatus, startBackgroundSync };
