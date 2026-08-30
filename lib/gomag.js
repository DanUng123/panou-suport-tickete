// Client API pentru GoMag (https://api.gomag.ro) -- REST, v1.
// Foloseste fetch nativ din Node (disponibil din Node 18+), fara dependente npm.
//
// MULTI-COMPANIE: fiecare functie exportata primeste `company` (obiectul
// intors de db.getCompany(), cu credentialele companiei) ca prim argument.
//
// Structura reala a raspunsului -- confirmata direct, prin testare live,
// NU doar din documentatia comunitatii (care avea inadvertente):
// - Comenzile vin ca un OBIECT (dictionar), cheie = id-ul comenzii, nu un array
// - Cheia API (Apikey) e necesara si la citire (GET), nu doar la scriere,
//   desi documentatia neoficiala spunea altfel
// - Nu exista separat payment_status / shipping_status ca la MerchantPro --
//   exista un status general (statusId/status) + payment.completed (0/1)

const GOMAG_BASE_URL = process.env.GOMAG_BASE_URL_OVERRIDE || 'https://api.gomag.ro';

function isConfigured(company) {
  return Boolean(company.gomagShopUrl && company.gomagApiKey);
}

async function request(company, method, path, params = {}) {
  if (!isConfigured(company)) {
    throw new Error('Integrarea GoMag nu este configurată pentru această companie (completați datele în Setări).');
  }
  const url = new URL(`${GOMAG_BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'ApiShop': company.gomagShopUrl,
      'Apikey': company.gomagApiKey,
      'User-Agent': 'SuportMaster-Integration/1.0',
    },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* fara body */ }
  if (!res.ok) {
    const msg = (data && data.message) || `Eroare GoMag ${res.status}`;
    throw new Error(msg);
  }
  if (data && data.error) {
    // GoMag intoarce uneori 200 OK, dar cu eroare in corpul raspunsului
    // (ex: "Nu exista cheia API") -- verificam explicit si acest caz
    throw new Error(data.message || `Eroare GoMag ${data.error}`);
  }
  return data;
}

/** Extrage o pagina de comenzi din GoMag. Raspunsul are comenzile intr-un obiect (dictionar), nu array. */
async function listOrders(company, { page = 1, limit = 100 } = {}) {
  const data = await request(company, 'GET', '/api/v1/order/read/json', { page, limit });
  const ordersDict = data.orders || {};
  return {
    items: Object.values(ordersDict),
    total: Number(data.total) || 0,
    page: data.page || page,
    pages: data.pages || 1,
  };
}

/** Extrage TOATE comenzile, paginand automat. */
async function listAllOrders(company) {
  const limit = 100;
  let page = 1;
  let all = [];
  while (true) {
    const result = await listOrders(company, { page, limit });
    all = all.concat(result.items);
    if (page >= result.pages || !result.items.length) break;
    page += 1;
  }
  return all;
}

/** Extrage o pagina de produse din catalogul GoMag. Raspunsul are produsele intr-un obiect (dictionar), la fel ca la comenzi. */
async function listProducts(company, { page = 1, limit = 100 } = {}) {
  const data = await request(company, 'GET', '/api/v1/product/read/json', { page, limit });
  const productsDict = data.products || {};
  return {
    items: Object.values(productsDict),
    total: Number(data.total) || 0,
    page: data.page || page,
    pages: data.pages || 1,
  };
}

/** Extrage TOATE produsele, paginand automat. */
async function listAllProducts(company) {
  const limit = 100;
  let page = 1;
  let all = [];
  while (true) {
    const result = await listProducts(company, { page, limit });
    all = all.concat(result.items);
    if (page >= result.pages || !result.items.length) break;
    page += 1;
  }
  return all;
}

module.exports = {
  isConfigured,
  listOrders,
  listAllOrders,
  listProducts,
  listAllProducts,
};
