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
 * Intoarce o PAGINA din catalog; apelantul pagineaza cu `start`. Nu cauta:
 * MerchantPro nu accepta un filtru dupa nume pe produse (raspunde "No such
 * filter `name` defined"), asa ca aducem catalogul intreg si cautam local --
 * ceea ce oricum voiam, ca sa nu depinda tastatul clientului de API-ul lor.
 *
 * Limita e plafonata la 100, cat accepta si ei. Confirmat live: raspunsul
 * contine `images`, iar variantele (marime/culoare) apar in `variants` doar la
 * produsele care chiar au variante -- la unul simplu cheia lipseste cu totul,
 * deci apelantul nu se poate baza pe existenta ei.
 */
async function searchProducts(company, { limit = 20, start = 0 } = {}) {
  const params = new URLSearchParams();
  params.set('include', 'images,variants');
  params.set('limit', String(Math.min(100, Math.max(1, Number(limit) || 20))));
  params.set('start', String(Math.max(0, Number(start) || 0)));
  const data = await request(company, 'GET', `/api/v2/products?${params.toString()}`);

  const primaValoare = (obiect, nume) => {
    for (const n of nume) {
      const v = obiect ? obiect[n] : undefined;
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };

  /**
   * Un numar pozitiv, sau nimic.
   *
   * Zero inseamna "nu stim pretul", nu "e gratis": un produs pe zero lei e
   * aproape intotdeauna un camp necompletat, iar "0,00 lei" scris langa o
   * moara electrica arata a defectiune, nu a informatie.
   */
  const numar = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  /**
   * Pretul pe care il plateste clientul ACUM, plus cel taiat, cand produsul e
   * la reducere.
   *
   * MerchantPro nu trimite un camp "price": trimite `price_gross` (cu TVA,
   * adica exact cat plateste omul) si `price_net` (fara TVA). O varianta mai
   * veche a acestui cod cauta "price" si gasea un camp ramas pe zero -- de-aia
   * aparea 0,00 lei la orice produs.
   *
   * Documentatia spune ca `price_gross` e deja pretul redus, iar
   * `old_price_gross` cel dinainte. In practica sunt magazine care lasa
   * `price_gross` la pretul intreg si tin reducerea in alt camp. Ca sa mearga
   * si asa, si asa: luam toate campurile care ar putea fi un pret de vanzare
   * si pastram CEL MAI MIC dintre ele ca pret curent, iar cel mai mare ca pret
   * taiat. Un pret de vanzare nu e niciodata mai mare decat cel de lista, deci
   * regula asta nu poate alege gresit in defavoarea clientului.
   *
   * !! ATENTIE, verificat pe date reale: pretul de aici NU e neaparat cat
   * plateste clientul. Un produs prins intr-o PROMOTIE se vinde cu 299 lei in
   * timp ce API-ul raporteaza price_gross = 337,58 si old_price_gross = 399.
   * Promotiile nu apar nicaieri in raspuns -- nici ca un camp, nici printr-un
   * `include`, nici printr-un endpoint separat; API-ul lor nu le expune deloc.
   * De-aia pretul asta NU se mai arata clientului in formular, ci doar
   * operatorului in tichet, cu mentiunea ca poate sa nu includa promotiile.
   * Clientul vede pretul adevarat apasand pe link-ul catre pagina produsului.
   */
  const preturi = (obiect) => {
    const candidati = [
      'price_gross', 'special_price_gross', 'sale_price_gross', 'discount_price_gross',
      'promo_price_gross', 'final_price_gross', 'final_price', 'special_price', 'sale_price',
    ].map((n) => numar(obiect ? obiect[n] : null)).filter((n) => n !== null);

    // fara niciun pret cu TVA, cadem pe cele fara TVA -- mai bine un pret
    // aproximativ decat niciunul
    if (!candidati.length) {
      const net = numar(primaValoare(obiect, ['price_net', 'price_vat', 'price']));
      return { pret: net, pretVechi: null };
    }

    const curent = Math.min(...candidati);
    const listaVeche = ['old_price_gross', 'old_price_net', 'regular_price', 'list_price']
      .map((n) => numar(obiect ? obiect[n] : null)).filter((n) => n !== null);
    const maximul = Math.max(...candidati, ...listaVeche);
    return { pret: curent, pretVechi: maximul > curent ? maximul : null };
  };

  /**
   * Poza produsului.
   *
   * Atentie la `image_url`: la MerchantPro NU e un sir, e un obiect cu trei
   * marimi -- {thumb, medium, large}. Luat ca atare ajungea in baza drept
   * "[object Object]", adica o poza care nu se incarca niciodata. Vrem
   * `medium`: `thumb` e prea mic pentru lista de produse, `large` trage cateva
   * sute de kiloocteti degeaba, pe telefonul unui client.
   */
  const dinMarimi = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return primaValoare(o, ['medium', 'thumb', 'large', 'url', 'src']);
  };
  /**
   * Adresa produsului pe site-ul magazinului. O validam inainte s-o dam mai
   * departe: vine de la un sistem strain si ajunge intr-un link pe care apasa
   * clientul, deci acceptam doar http(s), nimic altceva.
   */
  const adresaProdusului = (p) => {
    const brut = primaValoare(p, ['url', 'product_url', 'link', 'permalink']);
    if (typeof brut !== 'string') return null;
    try {
      const u = new URL(brut);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href.slice(0, 500) : null;
    } catch (e) { return null; }
  };

  const primaImagine = (p) => {
    const lista = Array.isArray(p.images) ? p.images : (Array.isArray(p.image) ? p.image : []);
    for (const im of lista) {
      if (typeof im === 'string' && im) return im;
      const u = dinMarimi(im && im.image_url) || primaValoare(im, ['url', 'src', 'link', 'thumbnail']) || dinMarimi(im);
      if (typeof u === 'string' && u) return u;
    }
    const direct = dinMarimi(p.image_url) || primaValoare(p, ['image_url', 'thumbnail_url', 'main_image']);
    return typeof direct === 'string' && direct ? direct : null;
  };

  /**
   * Numele unei variante. MerchantPro nu-i da un nume gata facut: da
   * `variant_options`, o lista de perechi atribut/valoare ("Culoare: Negru",
   * "Marime: 42"), din care il compunem noi. Cand lipsesc, cadem pe codul ei.
   */
  const numeVarianta = (v) => {
    const optiuni = Array.isArray(v.variant_options) ? v.variant_options : [];
    const bucati = optiuni.map((o) => {
      const valoare = primaValoare(o, ['value', 'option_value', 'value_name', 'name']);
      const atribut = primaValoare(o, ['attribute_name', 'attribute', 'option_name', 'label']);
      if (!valoare) return null;
      return atribut && String(atribut) !== String(valoare) ? `${atribut}: ${valoare}` : String(valoare);
    }).filter(Boolean);
    if (bucati.length) return bucati.join(' · ');
    return primaValoare(v, ['name', 'title', 'label', 'sku', 'ean']) || `Varianta ${v.id}`;
  };

  /** O varianta ascunsa in magazin sau iesita din stoc nu are ce cauta intr-un schimb. */
  // Steaguri: magazinul le trimite si ca 1/0, si ca true/false, si ca siruri
  // ("on", "active", "visible", "hidden"). `inventory_enabled` vine ca "on",
  // nu ca 1 -- verificat pe raspunsul real.
  const NEGATIVE = ['0', 'false', 'off', 'no', 'hidden', 'inactive', 'disabled', 'invisible', 'unlisted'];
  const POZITIVE = ['1', 'true', 'on', 'yes', 'active', 'visible', 'listed', 'enabled'];
  const steag = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const t = String(v).trim().toLowerCase();
    if (NEGATIVE.includes(t)) return false;
    if (POZITIVE.includes(t)) return true;
    return null; // ceva ce nu intelegem: nu tragem nicio concluzie
  };

  /**
   * Se poate cere la schimb? Un produs ascuns, scos din vanzare sau epuizat nu
   * are ce cauta in lista din care alege clientul -- ar cere ceva ce magazinul
   * nu are cum sa-i trimita.
   *
   * Regula e blanda intentionat: excludem doar cand magazinul spune raspicat
   * "nu". Un camp lipsa sau o valoare pe care nu o recunoastem inseamna
   * "disponibil", nu invers -- altfel un magazin care raporteaza altfel decat
   * ne asteptam ar ramane cu catalogul gol.
   */
  const eDisponibil = (o) => {
    for (const camp of ['status', 'visibility', 'is_visible', 'visible', 'active', 'in_stock']) {
      if (steag(o ? o[camp] : null) === false) return false;
    }
    // inventory_enabled fals inseamna ca magazinul NU tine evidenta stocului
    // pentru produsul asta -- deci e mereu disponibil, nu mereu epuizat
    const urmareste = steag(primaValoare(o, ['inventory_enabled', 'track_inventory']));
    if (urmareste === true) {
      const stoc = Number(primaValoare(o, ['stock', 'quantity', 'stock_quantity']));
      if (Number.isFinite(stoc) && stoc <= 0) return false;
    }
    return true;
  };
  const variantaDisponibila = eDisponibil;

  const toate = data?.data || [];
  return {
    // `total` ramane numarul raportat de magazin, nu cate am pastrat noi --
    // apelantul se bazeaza pe el ca sa stie cand s-a terminat paginarea
    total: data?.meta?.count?.total ?? toate.length,
    // cate randuri a trimis magazinul pe pagina asta, INAINTE de filtrare.
    // Paginarea trebuie sa se uite la asta, nu la cate am pastrat: o pagina
    // de 100 din care 60 sunt epuizate ar parea "ultima pagina" si importul
    // s-ar opri la un sfert de catalog.
    fetched: toate.length,
    // produsele ascunse, scoase din vanzare sau epuizate nu intra in catalog:
    // n-are rost sa ceara clientul la schimb ceva ce nu i se poate trimite
    products: toate.filter(eDisponibil).map((p) => {
      const pp = preturi(p);
      return {
        id: p.id,
        name: primaValoare(p, ['name', 'title', 'product_name']) || `Produs ${p.id}`,
        sku: primaValoare(p, ['sku', 'code', 'product_code', 'model']),
        price: pp.pret,
        oldPrice: pp.pretVechi,
        currency: primaValoare(p, ['currency', 'currency_code']),
        imageUrl: primaImagine(p),
        // adresa produsului in magazin. E singurul loc unde pretul e sigur
        // corect: pretul din API nu include promotiile in curs (vezi mai jos).
        url: adresaProdusului(p),
        variants: Array.isArray(p.variants)
          ? p.variants.filter(variantaDisponibila).map((v) => {
            const pv = preturi(v);
            return {
              id: v.id,
              name: numeVarianta(v),
              sku: primaValoare(v, ['sku', 'code']),
              price: pv.pret,
              oldPrice: pv.pretVechi,
            };
          })
          : [],
      };
    }),
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
  // acces brut la API, folosit doar de diagnosticul din Setari
  requestRaw: request,
};
