// Client API pentru MerchantPro (https://docs.merchantpro.com) -- REST, v2.
// Foloseste fetch nativ din Node (disponibil din Node 18+), fara dependente npm.
//
// MULTI-COMPANIE: fiecare functie exportata primeste acum `company` (obiectul
// intors de db.getCompany(), cu credentialele companiei) ca prim argument, in
// loc sa citeasca variabile de mediu globale la incarcarea modulului.

function isConfigured(company) {
  return Boolean(company.merchantProShopUrl && company.merchantProApiKey && company.merchantProApiSecret && company.merchantProActive !== false);
}

function authHeader(company) {
  const token = Buffer.from(`${company.merchantProApiKey}:${company.merchantProApiSecret}`).toString('base64');
  return `Basic ${token}`;
}

async function request(company, method, path, body) {
  if (!isConfigured(company)) {
    throw new Error('Integrarea MerchantPro nu este configurată pentru această companie (completați datele în Setări).');
  }
  const url = `${company.merchantProShopUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': authHeader(company),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* fara body */ }
  if (!res.ok) {
    let msg = `Eroare MerchantPro ${res.status}`;
    if (data) {
      const raw = data.message || data.error;
      if (typeof raw === 'string') msg = raw;
      else if (raw && typeof raw === 'object') msg = raw.message || JSON.stringify(raw);
      else if (data.errors) msg = JSON.stringify(data.errors);
    }
    throw new Error(msg);
  }
  return data;
}

/**
 * Extrage o pagina de comenzi din MerchantPro.
 * filters poate contine: created_after, created_before, ids, shipping_status,
 * payment_status, sort, start, limit (max 100).
 */
async function listOrders(company, filters = {}) {
  const params = new URLSearchParams();
  params.set('include', 'line_items');
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  });
  const data = await request(company, 'GET', `/api/v2/orders?${params.toString()}`);
  return data; // { data: [...], meta: { count: {...}, links: {...} } }
}

/** Extrage TOATE comenzile care corespund filtrelor, paginand automat. */
async function listAllOrders(company, filters = {}) {
  const limit = 100;
  let start = 0;
  let all = [];
  while (true) {
    const page = await listOrders(company, { ...filters, start, limit });
    all = all.concat(page.data || []);
    const total = page.meta?.count?.total ?? all.length;
    start += limit;
    if (start >= total || !page.data || page.data.length === 0) break;
  }
  return all;
}

async function getOrder(company, mpId) {
  return request(company, 'GET', `/api/v2/orders/${mpId}?include=line_items`);
}

/** Actualizeaza campuri pe o comanda (ex: shipping_awb dupa generare AWB). */
async function updateOrder(company, mpId, patch) {
  return request(company, 'PATCH', `/api/v2/orders/${mpId}`, patch);
}

/** Scurtaturi de procesare oferite de API (schimba shipping_status). */
async function markOrderStatus(company, mpId, action) {
  // action: in_process | shipped | delivered | returned | cancelled
  return request(company, 'PATCH', `/api/v2/orders/${mpId}/${action}`);
}

/** Declanseaza emiterea facturii in MerchantPro pentru o comanda. */
async function issueInvoice(company, mpId) {
  return request(company, 'PATCH', `/api/v2/orders/${mpId}/create_invoice`);
}

module.exports = {
  isConfigured,
  listOrders,
  listAllOrders,
  getOrder,
  updateOrder,
  markOrderStatus,
  issueInvoice,
};
