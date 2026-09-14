// Aducerea catalogului de produse al magazinului in baza noastra.
//
// La ce foloseste: la "colet la schimb", clientul trebuie sa aleaga produsul
// cu care vrea sa inlocuiasca. Ca sa poata alege, trebuie sa vada ce vinde
// magazinul.
//
// De ce copiem catalogul in loc sa intrebam magazinul la fiecare cautare:
// cautarea o face clientul in timp ce scrie, iar noi suntem un singur proces
// cu o baza sincrona. O cerere HTTP catre magazin la fiecare tasta ar
// insemna ca un magazin lent tine in loc intreaga platforma, pentru toti
// clientii ei. Asa, importul se face periodic, in fundal, iar cautarea e
// locala.

const mp = require('./merchantpro');
const db = require('./db');

// Cat aducem intr-o pagina de la MerchantPro (maximul lor e 100).
const PAGINA = 100;
// Plafon dur: chiar si un magazin urias ramane marginit ca timp si disc.
const MAX_PRODUSE = Number(process.env.CATALOG_MAX_PRODUCTS || 60000);
// Cat de des reimprospatam automat catalogul unui magazin.
//
// La sase ore, nu la douazeci si patru: pretul pe care il vede clientul e o
// COPIE a pretului din magazin, iar o promotie pornita dimineata ar ramane
// altfel cu pretul vechi pana a doua zi. Sase ore inseamna patru treceri prin
// catalog pe zi -- neglijabil pentru magazin, si destul cat sa nu vada nimeni
// un pret vechi de o zi intreaga.
const REIMPROSPATARE_MS = Number(process.env.CATALOG_REFRESH_HOURS || 6) * 3600 * 1000;

// Un import pe companie, nu mai multe deodata: butonul din Setari poate fi
// apasat de doua ori, iar ciclul din fundal poate cadea peste el.
const inCurs = new Set();
const ultimulRezultat = {}; // companyId -> { ok, count, removed, error, finishedAt }

function catalogState(companyId) {
  return {
    running: inCurs.has(companyId),
    last: ultimulRezultat[companyId] || null,
    ...db.getCatalogStatus(companyId),
  };
}

/**
 * Aduce tot catalogul unei companii. Intoarce { ok, count, removed } sau
 * { ok: false, error }. Nu arunca: un catalog care nu se poate aduce nu
 * trebuie sa doboare nimic, doar sa fie raportat.
 */
async function importCatalogForCompany(company) {
  if (!company || !mp.isConfigured(company)) {
    return { ok: false, error: 'Integrarea MerchantPro nu e configurată pentru acest magazin.' };
  }
  if (inCurs.has(company.id)) return { ok: false, error: 'Catalogul se aduce deja.' };
  inCurs.add(company.id);

  // aceeasi eticheta pe tot importul: la final, produsele ramase cu o eticheta
  // mai veche sunt exact cele scoase din magazin
  const eticheta = new Date().toISOString();
  let total = 0;
  try {
    let start = 0;
    while (start < MAX_PRODUSE) {
      const pagina = await mp.searchProducts(company, { limit: PAGINA, start });
      const produse = pagina.products || [];
      // `fetched` = cate randuri a trimis magazinul, INAINTE ca produsele
      // ascunse sau epuizate sa fie scoase. Paginarea se uita la el, nu la
      // cate am pastrat -- altfel o pagina plina din care jumatate sunt
      // epuizate ar arata ca ultima pagina si importul s-ar opri la mijloc.
      const aduse = pagina.fetched != null ? pagina.fetched : produse.length;
      if (!aduse) break;
      if (produse.length) total += db.upsertProducts(company.id, produse, eticheta);
      if (aduse < PAGINA) break;
      start += PAGINA;
      // lasam bucla de evenimente sa respire intre pagini: scrierea e sincrona
      // si, la zeci de mii de produse, fara pauza serverul n-ar mai raspunde
      await new Promise((r) => setTimeout(r, 15));
    }
    const sterse = total ? db.pruneProducts(company.id, eticheta) : 0;
    ultimulRezultat[company.id] = { ok: true, count: total, removed: sterse, finishedAt: new Date().toISOString() };
    console.log(`Catalog adus pentru ${company.name}: ${total} produse (${sterse} scoase).`);
    return { ok: true, count: total, removed: sterse };
  } catch (e) {
    ultimulRezultat[company.id] = { ok: false, error: e.message, finishedAt: new Date().toISOString() };
    console.error(`Catalogul nu a putut fi adus pentru ${company.name}: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    inCurs.delete(company.id);
  }
}

/** Porneste importul fara sa astepte -- pentru butonul din Setari si pentru pornirea automata. */
function startImport(company) {
  if (inCurs.has(company.id)) return false;
  importCatalogForCompany(company).catch(() => { /* deja raportat */ });
  return true;
}

/**
 * Aduce catalogul doar daca are rost: magazinul chiar foloseste schimbul cu
 * alt produs, si catalogul lipseste sau e vechi. Chemata la pornire si o data
 * pe ora din fundal.
 */
function refreshIfStale(company) {
  const reguli = db.getReturSettings(company.id);
  if (!reguli || !reguli.exchangeOther) return false;
  if (!mp.isConfigured(company)) return false;
  const stare = db.getCatalogStatus(company.id);
  if (stare.count && stare.lastSyncedAt && Date.now() - new Date(stare.lastSyncedAt).getTime() < REIMPROSPATARE_MS) {
    return false;
  }
  return startImport(company);
}

/** Ciclul din fundal: trece o data pe ora prin magazine si reimprospateaza ce e vechi. */
function startBackgroundCatalogSync() {
  const rundă = () => {
    let companii = [];
    try { companii = db.listAllCompanies(); } catch (e) { return; }
    for (const c of companii) {
      try { refreshIfStale(c); } catch (e) { /* un magazin cu probleme nu opreste restul */ }
    }
  };
  // prima runda dupa un minut, ca sa nu se suprapuna peste pornirea serverului
  setTimeout(rundă, 60 * 1000);
  setInterval(rundă, 60 * 60 * 1000);
}

module.exports = {
  importCatalogForCompany,
  startImport,
  refreshIfStale,
  startBackgroundCatalogSync,
  catalogState,
};
