// Motor de sincronizare periodica: aduce comenzi din MerchantPro si le
// salveaza/actualizeaza in baza de date locala.
//
// Strategie (fara acces confirmat la webhook-uri MerchantPro):
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

let syncing = false;
let lastSyncResult = null;
let lastSyncError = null;

async function runSync() {
  if (!mp.isConfigured()) {
    lastSyncError = 'Integrarea MerchantPro nu este configurată (variabile de mediu lipsă).';
    return { skipped: true, reason: lastSyncError };
  }
  if (syncing) return { skipped: true, reason: 'Sincronizare deja în curs.' };

  syncing = true;
  const startedAt = Date.now();
  let created = 0;
  let updated = 0;

  try {
    // 1. comenzi noi / recente
    const sinceISO = new Date(Date.now() - SYNC_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recent = await mp.listAllOrders({ created_after: sinceISO, sort: 'date_created.desc' });
    for (const mpOrder of recent) {
      const { isNew } = db.upsertOrderFromMerchantPro(mpOrder);
      if (isNew) created += 1; else updated += 1;
    }

    // 2. comenzi locale inca active, dar mai vechi decat fereastra de mai sus
    //    (ca sa prindem si schimbari de status pe comenzi mai vechi)
    const activeLocal = db.listOrders({}).filter((o) => !TERMINAL_SHIPPING_STATUSES.includes(o.shippingStatus));
    const recentIds = new Set(recent.map((o) => o.id));
    const staleActiveIds = activeLocal.map((o) => o.mpId).filter((id) => !recentIds.has(id));

    for (let i = 0; i < staleActiveIds.length; i += 50) {
      const batch = staleActiveIds.slice(i, i + 50);
      if (!batch.length) continue;
      const page = await mp.listOrders({ ids: batch.join(','), limit: 100 });
      for (const mpOrder of page.data || []) {
        const { isNew } = db.upsertOrderFromMerchantPro(mpOrder);
        if (isNew) created += 1; else updated += 1;
      }
    }

    lastSyncResult = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      created,
      updated,
      totalChecked: recent.length + staleActiveIds.length,
    };
    lastSyncError = null;
    return lastSyncResult;
  } catch (e) {
    lastSyncError = e.message;
    throw e;
  } finally {
    syncing = false;
  }
}

function getSyncStatus() {
  return { syncing, lastSyncResult, lastSyncError, configured: mp.isConfigured() };
}

let intervalHandle = null;

function startBackgroundSync(intervalMs) {
  if (intervalHandle) return;
  if (!mp.isConfigured()) {
    console.log('Sincronizare MerchantPro dezactivată (variabile de mediu lipsă).');
    return;
  }
  console.log(`Sincronizare MerchantPro activă, la fiecare ${Math.round(intervalMs / 1000)}s.`);
  runSync().catch((e) => console.error('Eroare la sincronizarea inițială MerchantPro:', e.message));
  intervalHandle = setInterval(() => {
    runSync().catch((e) => console.error('Eroare la sincronizarea MerchantPro:', e.message));
  }, intervalMs);
}

module.exports = { runSync, getSyncStatus, startBackgroundSync };
