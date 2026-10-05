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
const opencart = require('./opencart');
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
function upsertBatch(shopSauCompanyId, mpOrders) {
  let created = 0;
  let updated = 0;
  let skippedIncompleteCard = 0;
  for (let i = 0; i < mpOrders.length; i += UPSERT_BATCH_SIZE) {
    const slice = mpOrders.slice(i, i + UPSERT_BATCH_SIZE);
    db.runInTransaction(() => {
      for (const mpOrder of slice) {
        if (isIncompleteCardPayment(mpOrder)) { skippedIncompleteCard += 1; continue; }
        const { isNew } = db.upsertOrderFromMerchantPro(shopSauCompanyId, mpOrder);
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
async function runSyncForCompany(company, magazin = null) {
  // Credentialele platformei sunt ale magazinului; steagurile de activare,
  // ale companiei. `tinta` le pune laolalta, asa cum le asteapta clientul.
  const shop = magazin || db.getPrimulMagazin(company.id);
  const tinta = shop ? db.magazinPentruClient(shop, company) : company;
  const cheieStare = shop ? `${company.id}:${shop.id}` : company.id;
  if (!mp.isConfigured(tinta)) {
    const reason = 'Integrarea MerchantPro nu este configurată pentru acest magazin.';
    lastSyncErrorByCompany[cheieStare] = reason;
    return { skipped: true, reason };
  }

  const startedAt = Date.now();
  let created = 0;
  let updated = 0;
  let skippedIncompleteCard = 0;

  try {
    // 1. comenzi noi / recente
    const sinceISO = new Date(Date.now() - SYNC_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recent = await mp.listAllOrders(tinta, { created_after: sinceISO, sort: 'date_created.desc' });
    const recentStats = upsertBatch(shop || company.id, recent);
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
      shopId: shop ? shop.id : null,
    });
    const recentIds = new Set(recent.map((o) => o.id));
    const staleActiveIds = activeMpIds.filter((id) => !recentIds.has(id));
    for (let i = 0; i < staleActiveIds.length; i += 50) {
      const batch = staleActiveIds.slice(i, i + 50);
      if (!batch.length) continue;
      const page = await mp.listOrders(tinta, { ids: batch.join(','), limit: 100 });
      const pageOrders = page.data || [];
      db.runInTransaction(() => {
        for (const mpOrder of pageOrders) {
          if (isIncompleteCardPayment(mpOrder)) {
            skippedIncompleteCard += 1;
            db.deleteOrderByMpId(shop || company.id, mpOrder.id);
            continue;
          }
          const { isNew } = db.upsertOrderFromMerchantPro(shop || company.id, mpOrder);
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
    lastSyncResultByCompany[cheieStare] = result;
    lastSyncErrorByCompany[cheieStare] = null;
    return result;
  } catch (e) {
    lastSyncErrorByCompany[cheieStare] = e.message;
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
async function runGomagSyncForCompany(company, magazin = null) {
  const shop = magazin || db.getPrimulMagazin(company.id);
  const tinta = shop ? db.magazinPentruClient(shop, company) : company;
  const cheieStare = shop ? `${company.id}:${shop.id}:gomag` : `${company.id}:gomag`;
  if (!gomag.isConfigured(tinta)) {
    return { skipped: true, reason: 'Integrarea GoMag nu este configurată pentru acest magazin.' };
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
      const products = await gomag.listAllProducts(tinta);
      for (const p of products) {
        if (p.sku && Array.isArray(p.images) && p.images.length) imageBySku[p.sku] = p.images[0];
      }
    } catch (e) {
      // daca preluarea catalogului esueaza, continuam fara imagini -- nu
      // blocam sincronizarea comenzilor propriu-zise pentru atat
    }

    const orders = await gomag.listAllOrders(tinta);
    for (const gmOrder of orders) {
      if (Array.isArray(gmOrder.items)) {
        for (const item of gmOrder.items) {
          if (item.sku && imageBySku[item.sku]) item.product_image_url = imageBySku[item.sku];
        }
      }
      const { isNew } = db.upsertOrderFromGomag(shop || company.id, gmOrder);
      if (isNew) created += 1; else updated += 1;
    }
    const result = { at: new Date().toISOString(), durationMs: Date.now() - startedAt, created, updated, totalChecked: orders.length };
    lastSyncResultByCompany[cheieStare] = result;
    lastSyncErrorByCompany[cheieStare] = null;
    return result;
  } catch (e) {
    lastSyncErrorByCompany[cheieStare] = e.message;
    throw e;
  }
}

/**
 * Sincronizeaza comenzile OpenCart ale UNEI SINGURE companii.
 *
 * Spre deosebire de GoMag, aici NU re-preluam tot istoricul la fiecare ciclu:
 * conectorul nostru stie sa filtreze dupa data ultimei modificari, deci cerem
 * doar ce s-a schimbat de la ultima rulare incoace. Important e ca filtrul sa
 * fie pe data MODIFICARII, nu a crearii -- altfel o comanda de acum o luna
 * care tocmai a fost marcata "livrata" n-ar mai ajunge la noi niciodata.
 *
 * La prima rulare nu exista "ultima data", deci se ia tot istoricul. Asta se
 * intampla o singura data per magazin.
 */
const OPENCART_LOOKBACK_HOURS = Number(process.env.OPENCART_SYNC_LOOKBACK_HOURS || 72);

async function runOpenCartSyncForCompany(company, { completa = false, magazin = null } = {}) {
  const shop = magazin || db.getPrimulMagazin(company.id);
  const tinta = shop ? db.magazinPentruClient(shop, company) : company;
  if (!opencart.isConfigured(tinta)) {
    return { skipped: true, reason: 'Integrarea OpenCart nu este configurată pentru acest magazin.' };
  }
  const cheie = shop ? `${company.id}:${shop.id}:opencart` : `${company.id}:opencart`;
  const startedAt = Date.now();
  let created = 0;
  let updated = 0;
  try {
    const anterioara = lastSyncResultByCompany[cheie];
    // Luam o fereastra ceva mai larga decat de la ultima rulare: daca
    // sincronizarea a fost oprita o vreme, sau ceasul serverului magazinului e
    // putin in urma, nu vrem sa sarim peste comenzi.
    const since = (completa || !anterioara)
      ? ''
      : new Date(Date.now() - OPENCART_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    const orders = await opencart.listAllOrders(tinta, { since });
    for (let i = 0; i < orders.length; i += 200) {
      const lot = orders.slice(i, i + 200);
      db.runInTransaction(() => {
        for (const ocOrder of lot) {
          const { isNew } = db.upsertOrderFromOpenCart(shop || company.id, ocOrder);
          if (isNew) created += 1; else updated += 1;
        }
      });
    }
    const result = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      created,
      updated,
      totalChecked: orders.length,
      completa: !since,
    };
    lastSyncResultByCompany[cheie] = result;
    lastSyncErrorByCompany[cheie] = null;
    return result;
  } catch (e) {
    lastSyncErrorByCompany[cheie] = e.message;
    throw e;
  }
}

/** Sincronizeaza TOATE companiile care au MerchantPro configurat. Folosita de sincronizarea din fundal. */
async function runSync() {
  if (syncing) return { skipped: true, reason: 'Sincronizare deja în curs.' };
  syncing = true;
  try {
    // Parcurgem MAGAZINE, nu companii: un client poate avea mai multe magazine
    // pe aceeasi platforma, iar fiecare are credentialele si comenzile lui.
    // Un magazin picat nu opreste restul -- fiecare isi raporteaza eroarea.
    const magazine = db.listAllActiveShops();
    const companiiDupaId = new Map(db.listAllCompanies().map((c) => [c.id, c]));
    const results = {};
    let sincronizate = 0;

    for (const shop of magazine) {
      const company = companiiDupaId.get(shop.companyId);
      if (!company) continue;
      const tinta = db.magazinPentruClient(shop, company);
      const cheie = `${company.id}:${shop.id}`;
      try {
        if (shop.platform === 'merchantpro' && mp.isConfigured(tinta)) {
          results[cheie] = await runSyncForCompany(company, shop);
          sincronizate += 1;
        } else if (shop.platform === 'gomag' && gomag.isConfigured(tinta)) {
          results[`${cheie}:gomag`] = await runGomagSyncForCompany(company, shop);
          sincronizate += 1;
        } else if (shop.platform === 'opencart' && opencart.isConfigured(tinta)) {
          results[`${cheie}:opencart`] = await runOpenCartSyncForCompany(company, { magazin: shop });
          sincronizate += 1;
        }
      } catch (e) {
        results[cheie] = { error: e.message, shop: shop.name };
      }
    }
    return { companiesSynced: sincronizate, shopsSynced: sincronizate, results };
  } finally {
    syncing = false;
  }
}

/** Statusul sincronizarii pentru O SINGURA companie (folosit de interfata). */
function getSyncStatus(company) {
  // Interfata arata inca o singura stare pe platforma. Cand o companie are mai
  // multe magazine, luam starea cea mai recenta dintre ele si adunam erorile,
  // ca un magazin picat sa nu treaca neobservat.
  const magazine = db.listShops(company.id, { doarActive: true });
  const stare = (sufix) => {
    const chei = magazine.map((s2) => `${company.id}:${s2.id}${sufix}`);
    chei.push(`${company.id}${sufix}`); // comenzi dinainte de migrare
    let celMaiNou = null;
    const erori = [];
    for (const k of chei) {
      const r = lastSyncResultByCompany[k];
      if (r && (!celMaiNou || r.at > celMaiNou.at)) celMaiNou = r;
      if (lastSyncErrorByCompany[k]) erori.push(lastSyncErrorByCompany[k]);
    }
    return { rezultat: celMaiNou, eroare: erori.length ? [...new Set(erori)].join(' · ') : null };
  };
  const starePrincipala = stare('');
  const stareGomag = stare(':gomag');
  const stareOpenCart = stare(':opencart');
  const primul = magazine[0] ? db.magazinPentruClient(magazine[0], company) : company;

  return {
    syncing,
    shops: magazine.map((s2) => ({ id: s2.id, name: s2.name, platform: s2.platform })),
    lastSyncResult: starePrincipala.rezultat,
    lastSyncError: starePrincipala.eroare,
    configured: mp.isConfigured(primul),
    gomag: {
      lastSyncResult: stareGomag.rezultat,
      lastSyncError: stareGomag.eroare,
      configured: gomag.isConfigured(primul),
    },
    opencart: {
      lastSyncResult: stareOpenCart.rezultat,
      lastSyncError: stareOpenCart.eroare,
      configured: opencart.isConfigured(primul),
    },
  };
}

let intervalHandle = null;
function startBackgroundSync(intervalMs) {
  if (intervalHandle) return;
  console.log(`Sincronizare comenzi din fundal activă, la fiecare ${Math.round(intervalMs / 1000)}s (toate magazinele configurate).`);
  runSync().catch((e) => console.error('Eroare la sincronizarea inițială a comenzilor:', e.message));
  intervalHandle = setInterval(() => {
    runSync().catch((e) => console.error('Eroare la sincronizarea comenzilor:', e.message));
  }, intervalMs);
}

module.exports = { runSync, runSyncForCompany, runGomagSyncForCompany, runOpenCartSyncForCompany, getSyncStatus, startBackgroundSync };
