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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': authHeader(company),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('MerchantPro: cererea a depășit limita de 30 secunde, fără răspuns.');
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
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

/**
 * Catalogul de produse -- necesar la "schimb cu alt produs", ca sa poata
 * clientul alege produsul nou din ce vinde efectiv magazinul.
 *
 * `q` cauta dupa nume; fara el intoarce inceputul catalogului. Limita e
 * plafonata la 100, cat accepta si API-ul lor. Confirmat live: raspunsul
 * contine `images`, iar variantele (marime/culoare) apar in `variants` doar la
 * produsele care chiar au variante -- la unul simplu cheia lipseste cu totul,
 * deci apelantul nu se poate baza pe existenta ei.
 */
async function searchProducts(company, { q = '', limit = 20, start = 0 } = {}) {
  const params = new URLSearchParams();
  params.set('include', 'images,variants');
  params.set('limit', String(Math.min(100, Math.max(1, Number(limit) || 20))));
  params.set('start', String(Math.max(0, Number(start) || 0)));
  if (q) params.set('name', q);
  const data = await request(company, 'GET', `/api/v2/products?${params.toString()}`);
  // Numele exacte ale campurilor de pret si de imagine nu sunt documentate, si
  // difera intre versiuni de magazin. Luam prima varianta care exista, in loc
  // sa presupunem una singura si sa ramanem cu preturi goale peste tot.
  const primaValoare = (obiect, nume) => {
    for (const n of nume) {
      const v = obiect ? obiect[n] : undefined;
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };
  const primaImagine = (p) => {
    const lista = Array.isArray(p.images) ? p.images : (Array.isArray(p.image) ? p.image : []);
    for (const im of lista) {
      if (typeof im === 'string' && im) return im;
      const u = primaValoare(im, ['url', 'src', 'link', 'image_url', 'thumbnail']);
      if (u) return u;
    }
    return primaValoare(p, ['image_url', 'thumbnail_url', 'main_image']);
  };

  return {
    total: data?.meta?.count?.total ?? (data?.data || []).length,
    products: (data?.data || []).map((p) => ({
      id: p.id,
      name: primaValoare(p, ['name', 'title', 'product_name']) || `Produs ${p.id}`,
      sku: primaValoare(p, ['sku', 'code', 'product_code', 'model']),
      price: (() => {
        const v = primaValoare(p, ['price', 'price_vat', 'final_price', 'sale_price', 'base_price']);
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })(),
      currency: primaValoare(p, ['currency', 'currency_code']),
      imageUrl: primaImagine(p),
      variants: Array.isArray(p.variants)
        ? p.variants.map((v) => ({
          id: v.id,
          name: primaValoare(v, ['name', 'title', 'label', 'value']) || '',
          sku: primaValoare(v, ['sku', 'code']),
        }))
        : [],
    })),
  };
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
  searchProducts,
};
