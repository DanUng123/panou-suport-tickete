// Import unic, complet, al TUTUROR comenzilor unei companii, de la
// inceputul magazinului pana in prezent -- separat de sincronizarea
// normala (care ruleaza la fiecare 2 minute si acopera doar comenzi
// recente). Ruleaza in fundal, cu progres urmaribil, dat fiind volumul
// mare posibil (zeci de mii de comenzi) -- nu blocheaza raspunsul HTTP
// initial. NOTA: comenzile sunt procesate de la cele mai NOI catre cele
// mai vechi (sort=date_created.desc -- singura valoare acceptata de
// MerchantPro, confirmata live; .asc a esuat cu eroare de validare) --
// rezultatul final e identic (toate comenzile ajung importate), doar
// ordinea de procesare difera.

const db = require('./db');
const mp = require('./merchantpro');

let importState = {
  running: false,
  companyId: null,
  processed: 0,
  total: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
};

function getImportStatus() {
  return { ...importState };
}

/** Bucla principala de import, incepand de la pozitia startFrom (0 = de la inceput). */
async function runImportLoop(company, startFrom) {
  try {
    const limit = 100;
    let start = startFrom;
    while (true) {
      let page;
      let lastErr;
      // reincercare automata, pana la 3 incercari, cu pauza crescanda --
      // o singura cerere agatata/esuata nu mai opreste tot importul
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          page = await mp.listOrders(company, { start, limit, sort: 'date_created.desc' });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }
      }
      if (lastErr) throw lastErr;

      const orders = page.data || [];
      const total = page.meta?.count?.total ?? 0;
      importState.total = total;

      for (const mpOrder of orders) {
        try {
          const { isNew } = db.upsertOrderFromMerchantPro(company.id, mpOrder);
          if (isNew) importState.created += 1; else importState.updated += 1;
        } catch (e) {
          importState.skipped += 1;
        }
        importState.processed += 1;
      }

      start += limit;
      if (!orders.length || start >= total) break;
      // pauza mica intre pagini, ca sa nu suprasolicitam API-ul MerchantPro
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    importState.running = false;
    importState.finishedAt = new Date().toISOString();
  } catch (e) {
    importState.running = false;
    importState.error = e.message;
    importState.finishedAt = new Date().toISOString();
  }
}

/** Porneste importul, de la inceput -- returneaza imediat, fara sa astepte finalizarea. */
function runFullHistoryImport(company) {
  if (importState.running) {
    return { skipped: true, reason: 'Un import este deja în curs.' };
  }
  importState = {
    running: true,
    companyId: company.id,
    processed: 0,
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  runImportLoop(company, 0);
  return { started: true };
}

/** Reia un import oprit din eroare, continuand de unde a ramas (nu o ia de la capat). */
function resumeFullHistoryImport(company) {
  if (importState.running) {
    return { skipped: true, reason: 'Un import este deja în curs.' };
  }
  if (!importState.error || importState.companyId !== company.id) {
    return { skipped: true, reason: 'Niciun import oprit din eroare, de reluat.' };
  }
  const resumeFrom = importState.processed;
  importState = { ...importState, running: true, error: null, finishedAt: null };
  runImportLoop(company, resumeFrom);
  return { started: true, resumedFrom: resumeFrom };
}

module.exports = { runFullHistoryImport, resumeFullHistoryImport, getImportStatus };
