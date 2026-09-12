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
//
// STARE PER-COMPANIE (nu globala) -- platforma e multi-tenant, iar
// importul se poate declansa acum automat, la fiecare companie noua care
// isi introduce credentialele pentru prima data (nu doar manual, de un
// singur admin, o data) -- mai multe companii pot importa simultan, fara
// sa se blocheze reciproc.

const db = require('./db');
const mp = require('./merchantpro');
const gomag = require('./gomag');

const statesByCompany = {}; // companyId -> stare import

function defaultState(companyId) {
  return {
    running: false,
    companyId,
    processed: 0,
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function getImportStatus(company) {
  return { ...(statesByCompany[company.id] || defaultState(company.id)) };
}

/** Bucla principala de import MerchantPro, incepand de la pozitia startFrom (0 = de la inceput). */
async function runMerchantProImportLoop(company, startFrom) {
  const state = statesByCompany[company.id];
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
      state.total = total;

      // O singura tranzactie pe pagina: la 900.000 de comenzi, diferenta
      // fata de o tranzactie per comanda e de la ore la zeci de minute.
      // Daca o comanda strica lotul, reluam pagina comanda cu comanda, ca
      // sa nu pierdem restul din cauza uneia singure.
      const before = { created: state.created, updated: state.updated, processed: state.processed };
      try {
        db.runInTransaction(() => {
          for (const mpOrder of orders) {
            const { isNew } = db.upsertOrderFromMerchantPro(company.id, mpOrder);
            if (isNew) state.created += 1; else state.updated += 1;
            state.processed += 1;
          }
        });
      } catch (e) {
        // tranzactia a fost anulata integral -- readucem contoarele la starea
        // dinainte si reluam pagina, comanda cu comanda
        state.created = before.created;
        state.updated = before.updated;
        state.processed = before.processed;
        for (const mpOrder of orders) {
          try {
            const { isNew } = db.upsertOrderFromMerchantPro(company.id, mpOrder);
            if (isNew) state.created += 1; else state.updated += 1;
          } catch (e2) {
            state.skipped += 1;
          }
          state.processed += 1;
        }
      }

      start += limit;
      if (!orders.length || start >= total) break;
      // pauza mica intre pagini, ca sa nu suprasolicitam API-ul MerchantPro
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    state.running = false;
    state.finishedAt = new Date().toISOString();
  } catch (e) {
    state.running = false;
    state.error = e.message;
    state.finishedAt = new Date().toISOString();
  }
}

/** Bucla principala de import GoMag -- catalogul lor nu suporta paginare pe interval de date confirmata, reluam totul dintr-o data. */
async function runGomagImportLoop(company) {
  const state = statesByCompany[company.id];
  try {
    const orders = await gomag.listAllOrders(company);
    state.total = orders.length;
    for (const gmOrder of orders) {
      try {
        const { isNew } = db.upsertOrderFromGomag(company.id, gmOrder);
        if (isNew) state.created += 1; else state.updated += 1;
      } catch (e) {
        state.skipped += 1;
      }
      state.processed += 1;
    }
    state.running = false;
    state.finishedAt = new Date().toISOString();
  } catch (e) {
    state.running = false;
    state.error = e.message;
    state.finishedAt = new Date().toISOString();
  }
}

/** Porneste importul MerchantPro, de la inceput -- returneaza imediat, fara sa astepte finalizarea. */
function runFullHistoryImport(company) {
  const existing = statesByCompany[company.id];
  if (existing && existing.running) {
    return { skipped: true, reason: 'Un import este deja în curs.' };
  }
  statesByCompany[company.id] = { ...defaultState(company.id), running: true, startedAt: new Date().toISOString() };
  runMerchantProImportLoop(company, 0);
  return { started: true };
}

/** Porneste importul GoMag, de la inceput -- returneaza imediat, fara sa astepte finalizarea. */
function runFullHistoryImportGomag(company) {
  const existing = statesByCompany[company.id];
  if (existing && existing.running) {
    return { skipped: true, reason: 'Un import este deja în curs.' };
  }
  statesByCompany[company.id] = { ...defaultState(company.id), running: true, startedAt: new Date().toISOString() };
  runGomagImportLoop(company);
  return { started: true };
}

/** Reia un import MerchantPro oprit din eroare, continuand de unde a ramas (nu o ia de la capat). */
function resumeFullHistoryImport(company) {
  const existing = statesByCompany[company.id];
  if (existing && existing.running) {
    return { skipped: true, reason: 'Un import este deja în curs.' };
  }
  if (!existing || !existing.error) {
    return { skipped: true, reason: 'Niciun import oprit din eroare, de reluat.' };
  }
  const resumeFrom = existing.processed;
  statesByCompany[company.id] = { ...existing, running: true, error: null, finishedAt: null };
  runMerchantProImportLoop(company, resumeFrom);
  return { started: true, resumedFrom: resumeFrom };
}

/**
 * Declansare AUTOMATA, silentioasa -- apelata din ruta de salvare a
 * Setarilor, cand se detecteaza ca MerchantPro sau GoMag tocmai au fost
 * configurate pentru PRIMA DATA (compania nu avea integrarea activa
 * inainte de aceasta salvare). Nu afecteaza deloc importul manual (butonul
 * din interfata) -- daca unul ruleaza deja pentru aceasta companie
 * (indiferent cum a pornit), nu se porneste un al doilea, in paralel.
 */
function maybeStartAutoImport(company, { merchantProJustConfigured, gomagJustConfigured }) {
  if (merchantProJustConfigured) runFullHistoryImport(company);
  else if (gomagJustConfigured) runFullHistoryImportGomag(company);
}

module.exports = {
  runFullHistoryImport,
  runFullHistoryImportGomag,
  resumeFullHistoryImport,
  maybeStartAutoImport,
  getImportStatus,
};
