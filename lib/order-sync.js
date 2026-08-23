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
const db = require('./db');

const SYNC_LOOKBACK_HOURS = Number(process.env.MERCHANTPRO_SYNC_LOOKBACK_HOURS || 72);
const TERMINAL_SHIPPING_STATUSES = ['delivered', 'cancelled', 'returned'];

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
    for (const mpOrder of recent) {
      if (isIncompleteCardPayment(mpOrder)) { skippedIncompleteCard += 1; continue; }
      const { isNew } = db.upsertOrderFromMerchantPro(company.id, mpOrder);
      if (isNew) created += 1; else updated += 1;
    }

    // 2. comenzi locale inca active, dar mai vechi decat fereastra de mai sus
    const activeLocal = db.listOrders(company.id, {}).filter((o) => !TERMINAL_SHIPPING_STATUSES.includes(o.shippingStatus));
    const recentIds = new Set(recent.map((o) => o.id));
    const staleActiveIds = activeLocal.map((o) => o.mpId).filter((id) => !recentIds.has(id));
    for (let i = 0; i < staleActiveIds.length; i += 50) {
      const batch = staleActiveIds.slice(i, i + 50);
      if (!batch.length) continue;
      const page = await mp.listOrders(company, { ids: batch.join(','), limit: 100 });
      for (const mpOrder of page.data || []) {
        if (isIncompleteCardPayment(mpOrder)) {
          skippedIncompleteCard += 1;
          db.deleteOrderByMpId(company.id, mpOrder.id);
          continue;
        }
        const { isNew } = db.upsertOrderFromMerchantPro(company.id, mpOrder);
        if (isNew) created += 1; else updated += 1;
      }
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

/** Sincronizeaza TOATE companiile care au MerchantPro configurat. Folosita de sincronizarea din fundal. */
async function runSync() {
  if (syncing) return { skipped: true, reason: 'Sincronizare deja în curs.' };
  syncing = true;
  try {
    const companies = db.listAllCompanies().filter((c) => mp.isConfigured(c));
    const results = {};
    for (const company of companies) {
      try {
        results[company.id] = await runSyncForCompany(company);
      } catch (e) {
        results[company.id] = { error: e.message };
      }
    }
    return { companiesSynced: companies.length, results };
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

module.exports = { runSync, runSyncForCompany, getSyncStatus, startBackgroundSync };
