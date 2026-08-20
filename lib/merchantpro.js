// Client API pentru MerchantPro (https://docs.merchantpro.com) -- REST, v2.
// Foloseste fetch nativ din Node (disponibil din Node 18+), fara dependente npm.
//
// Necesita 3 variabile de mediu:
//   MERCHANTPRO_SHOP_URL    -- ex: https://numele-magazinului.ro
//   MERCHANTPRO_API_KEY     -- din contul MerchantPro, pagina "API Access"
//   MERCHANTPRO_API_SECRET  -- idem

const SHOP_URL = process.env.MERCHANTPRO_SHOP_URL || '';
const API_KEY = process.env.MERCHANTPRO_API_KEY || '';
const API_SECRET = process.env.MERCHANTPRO_API_SECRET || '';

function isConfigured() {
  return Boolean(SHOP_URL && API_KEY && API_SECRET);
}

function authHeader() {
  const token = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

async function request(method, path, body) {
  if (!isConfigured()) {
    throw new Error('Integrarea MerchantPro nu este configurată (lipsesc variabilele de mediu).');
  }
  const url = `${SHOP_URL.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': authHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch (e) { /* fara body */ }

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Eroare MerchantPro ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Extrage o pagina de comenzi din MerchantPro.
 * filters poate contine: created_after, created_before, ids, shipping_status,
 * payment_status, sort, start, limit (max 100).
 */
async function listOrders(filters = {}) {
  const params = new URLSearchParams();
  params.set('include', 'line_items');
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  });
  const data = await request('GET', `/api/v2/orders?${params.toString()}`);
  return data; // { data: [...], meta: { count: {...}, links: {...} } }
}

/** Extrage TOATE comenzile care corespund filtrelor, paginand automat. */
async function listAllOrders(filters = {}) {
  const limit = 100;
  let start = 0;
  let all = [];
  while (true) {
    const page = await listOrders({ ...filters, start, limit });
    all = all.concat(page.data || []);
    const total = page.meta?.count?.total ?? all.length;
    start += limit;
    if (start >= total || !page.data || page.data.length === 0) break;
  }
  return all;
}

async function getOrder(mpId) {
  return request('GET', `/api/v2/orders/${mpId}?include=line_items`);
}

/** Actualizeaza campuri pe o comanda (ex: shipping_awb dupa generare AWB). */
async function updateOrder(mpId, patch) {
  return request('PATCH', `/api/v2/orders/${mpId}`, patch);
}

/** Scurtaturi de procesare oferite de API (schimba shipping_status). */
async function markOrderStatus(mpId, action) {
  // action: in_process | shipped | delivered | returned | cancelled
  return request('PATCH', `/api/v2/orders/${mpId}/${action}`);
}

/** Declanseaza emiterea facturii in MerchantPro pentru o comanda. */
async function issueInvoice(mpId) {
  return request('PATCH', `/api/v2/orders/${mpId}/create_invoice`);
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
