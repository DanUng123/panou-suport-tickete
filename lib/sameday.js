// Client pentru API-ul Sameday Courier (REST/JSON).
// Construit pe baza SDK-ului PHP oficial (github.com/sameday-courier/php-sdk)
// si a fragmentelor de documentatie oficiala gasite -- API-ul propriu-zis
// Sameday nu publica un URL de productie predictibil (e primit individual
// de la echipa lor), asa ca acesta se configureaza explicit.
//
// IMPORTANT: cateva detalii (caile exacte pentru servicii/puncte de ridicare/
// judete-localitati, si campul exact pentru "ridicare de la o alta adresa
// decat punctul de ridicare inregistrat", necesar pentru fluxul nostru de
// Service/Retur/Schimb) sunt inferate din numele claselor SDK-ului oficial,
// nu confirmate printr-un apel real. Inainte de a genera vreun AWB real,
// verificati cu un apel de test (GET, fara efecte) ca structura raspunsului
// se potriveste cu ce asteapta acest modul -- vedeti functia getServices().
//
// Foloseste doar fetch nativ din Node -- fara dependente npm.
//
// Necesita variabile de mediu:
//   SAMEDAY_USERNAME, SAMEDAY_PASSWORD  -- credentialele contului
//   SAMEDAY_PICKUP_POINT_ADDRESS        -- adresa punctului de ridicare (text,
//                                          folosit pentru a-l identifica automat
//                                          din lista GetPickupPoints)
//   SAMEDAY_ENVIRONMENT                 -- "production" (implicit) sau "test"
//   SAMEDAY_BASE_URL_PRODUCTION         -- optional, implicit https://api.sameday.ro
//   SAMEDAY_BASE_URL_TEST                -- optional, implicit https://sameday-api.demo.zitec.com

function cfg() {
  return {
    username: process.env.SAMEDAY_USERNAME || '',
    password: process.env.SAMEDAY_PASSWORD || '',
    pickupPointAddress: process.env.SAMEDAY_PICKUP_POINT_ADDRESS || '',
    environment: (process.env.SAMEDAY_ENVIRONMENT || 'production').toLowerCase(),
    senderName: process.env.SAMEDAY_SENDER_NAME || '',
    senderPhone: process.env.SAMEDAY_SENDER_PHONE || '',
    senderPostalCode: process.env.SAMEDAY_SENDER_POSTAL_CODE || '',
    senderAddress: process.env.SAMEDAY_SENDER_ADDRESS || '',
  };
}

function isConfigured() {
  const c = cfg();
  const hasPickupPoint = Boolean(process.env.SAMEDAY_PICKUP_POINT_ID || c.pickupPointAddress);
  return Boolean(c.username && c.password && hasPickupPoint);
}

function getBaseUrl() {
  const c = cfg();
  if (c.environment === 'test') {
    return process.env.SAMEDAY_BASE_URL_TEST || 'https://sameday-api.demo.zitec.com';
  }
  return process.env.SAMEDAY_BASE_URL_PRODUCTION || 'https://api.sameday.ro';
}

// token-ul de autentificare se cacheaza in memorie (valabil o perioada,
// nu stim exact cat -- il reinnoim daca primim 401)
let cachedToken = null;

async function authenticate() {
  const c = cfg();
  const res = await fetch(`${getBaseUrl()}/api/authenticate`, {
    method: 'POST',
    headers: {
      'X-AUTH-USERNAME': c.username,
      'X-AUTH-PASSWORD': c.password,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`Sameday: raspuns neasteptat la autentificare (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`Sameday: autentificare esuata (${res.status}): ${data.message || text}`);
  const token = data.token || data.data?.token || data.access_token;
  if (!token) throw new Error('Sameday: token lipsa din raspunsul de autentificare.');
  cachedToken = token;
  return token;
}

/** Extrage recursiv, din structura de validare Sameday, doar campurile care chiar au o eroare (ignora sutele de campuri goale {}). */
function extractValidationErrors(obj, path = '', found = []) {
  if (!obj || typeof obj !== 'object') return found;
  if (Array.isArray(obj.errors) && obj.errors.length) {
    found.push(`${path || 'root'}: ${obj.errors.join('; ')}`);
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'errors') continue;
    if (val && typeof val === 'object') extractValidationErrors(val, path ? `${path}.${key}` : key, found);
  }
  return found;
}

async function request(method, path, { body, query } = {}, retryOn401 = true) {
  if (!cachedToken) await authenticate();
  let url = `${getBaseUrl()}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'X-AUTH-TOKEN': cachedToken,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retryOn401) {
    cachedToken = null;
    await authenticate();
    return request(method, path, { body, query }, false);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const specificErrors = extractValidationErrors(data.errors);
    const detail = specificErrors.length ? specificErrors.join(' | ') : (data.message || JSON.stringify(data).slice(0, 300));
    throw new Error(`Sameday: eroare ${res.status} la ${method} ${path} — ${detail}`);
  }
  return data;
}

/** Lista serviciilor disponibile pentru contul autentificat (contine ID-uri necesare la creare AWB). */
async function getServices() {
  const data = await request('GET', '/api/client/services');
  return data.data || data.services || data;
}

/** Lista punctelor de ridicare configurate pentru cont. */
async function getPickupPoints() {
  const data = await request('GET', '/api/client/pickup-points');
  return data.data || data.pickupPoints || data;
}

function normalizeAddr(s) {
  return normalizeRoName(s).replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Identifica automat punctul de ridicare configurat.
 * Prioritate: SAMEDAY_PICKUP_POINT_ID explicit (cel mai sigur) > potrivire
 * dupa adresa configurata > singurul punct marcat "defaultPickupPoint".
 */
async function resolvePickupPointId() {
  const explicitId = process.env.SAMEDAY_PICKUP_POINT_ID;
  if (explicitId) return Number(explicitId);

  const c = cfg();
  const points = await getPickupPoints();
  const wantedAddr = normalizeAddr(c.pickupPointAddress);

  let match = points.find((p) => {
    const pAddr = normalizeAddr(p.address || '');
    return wantedAddr.includes(pAddr) || pAddr.includes(wantedAddr.split(' ').slice(0, 4).join(' '));
  });

  if (!match) {
    const defaults = points.filter((p) => p.defaultPickupPoint);
    if (defaults.length === 1) match = defaults[0];
  }

  if (!match) {
    const list = points.map((p) => `${p.id} — ${p.alias || p.address}`).join('; ');
    throw new Error(`Sameday: nu am găsit niciun punct de ridicare care să corespundă adresei configurate ("${c.pickupPointAddress}"). Puncte disponibile: ${list}. Poți seta direct SAMEDAY_PICKUP_POINT_ID.`);
  }
  return match.id;
}

/** Lista judetelor (pentru rezolvarea adresei destinatarului la ID numeric). */
async function getCounties(countryCode = 'RO') {
  const data = await request('GET', '/api/geolocation/county', { query: { countryCode } });
  return data.data || data.counties || data;
}

/** Lista localitatilor dintr-un judet (id-ul judetului obtinut din getCounties). */
async function getCities(countyId) {
  const data = await request('GET', '/api/geolocation/city', { query: { countyId } });
  return data.data || data.cities || data;
}

/** Cauta un judet dupa nume (potrivire aproximativa, fara diacritice). */
function normalizeRoName(s) {
  return String(s || '').toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i').replace(/ș/g, 's').replace(/ş/g, 's').replace(/ț/g, 't').replace(/ţ/g, 't')
    .trim();
}

async function resolveCountyAndCityIds(countyName, cityName) {
  const counties = await getCounties();
  const county = counties.find((c) => normalizeRoName(c.name) === normalizeRoName(countyName));
  if (!county) throw new Error(`Sameday: județul "${countyName}" nu a fost găsit în nomenclatorul Sameday.`);
  const cities = await getCities(county.id);
  const city = cities.find((c) => normalizeRoName(c.name) === normalizeRoName(cityName));
  if (!city) throw new Error(`Sameday: localitatea "${cityName}" nu a fost găsită în județul "${countyName}" (nomenclator Sameday).`);
  return { countyId: county.id, cityId: city.id };
}

/**
 * Creeaza un AWB de ridicare de la client (Service/Retur/Colet la schimb).
 * Structura cererii de mai jos e CONFIRMATA printr-un apel real catre
 * productie (22.08.2026) -- nu mai e o presupunere din SDK. Detalii:
 *  - endpoint real: POST /api/awb (NU /api/client/awb, cum ar sugera SDK-ul PHP)
 *  - codul postal e suficient pentru adresa -- nu mai e nevoie de
 *    ID-uri de judet/localitate (simplificare fata de varianta initiala)
 *  - awbPayment: 1 = plata (valoarea exacta semantica nu e confirmata,
 *    dar functioneaza -- a generat un AWB real, facturabil)
 *  - personType: 0 = persoana fizica (1 = firma, cere companyName)
 *  - thirdPartyPickup: true + obiectul thirdParty = ridicare de la alta
 *    adresa decat punctul de ridicare inregistrat (exact fluxul nostru)
 *
 * @param {{reason: 'service'|'retur'|'schimb', customerName, address, city, postalCode, phone, email, ticketId}} pickup
 */
async function createPickupAwb(pickup) {
  const pickupPointId = await resolvePickupPointId();

  const services = await getServices();
  // coduri confirmate printr-un apel real catre cont: RS = "Retur Standard"
  // (ridicare de la client -- folosit si pentru "service", Sameday nu are
  // un serviciu distinct pentru ridicare-service), CS = "Colet la schimb"
  // Colet la schimb: NU e un serviciu de sine statator -- e serviciul de baza
  // "24" (NextDay) + o taxa/serviciu suplimentar confirmat de client direct
  // din panoul Sameday (id 714230, taxCode SWAP). Retur/Service folosesc
  // serviciul de baza "RS" (Retur Standard), fara taxa suplimentara.
  const serviceCode = pickup.reason === 'schimb' ? '24' : 'RS';
  const service = services.find((s) => s.serviceCode === serviceCode);
  if (!service) throw new Error(`Sameday: serviciul "${serviceCode}" nu este activ în cont. Servicii disponibile: ${services.map((s) => `${s.serviceCode} (${s.name})`).join(', ')}`);

  const c = cfg();
  const party = {
    name: pickup.customerName,
    phoneNumber: pickup.phone,
    personType: 0,
    postalCode: pickup.postalCode,
    address: pickup.address,
  };
  if (!c.senderName || !c.senderPhone || !c.senderPostalCode || !c.senderAddress) {
    throw new Error('Sameday: datele voastre de contact (SAMEDAY_SENDER_NAME/PHONE/POSTAL_CODE/ADDRESS) nu sunt configurate pe server — sunt necesare ca destinatar real la ridicarea de la client.');
  }
  const usAsRecipient = {
    name: c.senderName,
    phoneNumber: c.senderPhone,
    personType: 0,
    postalCode: c.senderPostalCode,
    address: c.senderAddress,
  };

  const body = {
    pickupPoint: pickupPointId,
    packageType: pickup.reason === 'schimb' ? 0 : 1, // 714230 (SWAP) e confirmat pt packageType 0
    packageNumber: 1,
    packageWeight: 1,
    service: service.id,
    awbPayment: 1,
    cashOnDelivery: 0,
    insuredValue: 0,
    thirdPartyPickup: true,
    thirdParty: party, // terțul = clientul, de la care se ridică fizic coletul
    awbRecipient: usAsRecipient, // destinatarul real = noi (unde ajunge coletul)
    clientInternalReference: `${pickup.ticketId}-${Date.now()}`,
    parcels: [{ weight: 1 }],
  };
  // Colet la schimb: taxa/serviciul suplimentar confirmat direct din contul
  // clientului (panoul Sameday) -- id 714230, "Colet la schimb", packageType 0.
  if (pickup.reason === 'schimb') {
    body.serviceTaxes = [714230];
  }

  const data = await request('POST', '/api/awb', { body });
  return {
    trackingNumber: data.awbNumber || data.data?.awbNumber,
    parcelId: data.awbNumber || data.data?.awbNumber, // Sameday foloseste acelasi numar pt awb si tracking
    // Colet la schimb genereaza automat un AL DOILEA awb legat (returnAwbs) --
    // confirmat printr-un test real: un singur apel POST /api/awb produce
    // 2 awb-uri distincte, ambele trebuie urmarite/anulate separat.
    secondaryAwbNumber: data.returnAwbs?.[0]?.awbNumber || null,
    raw: data,
  };
}

/** Istoricul de status al unui AWB, normalizat la forma { StatusDescription, ... } (aceeasi ca la GLS, pentru cod comun). */
async function getAwbStatus(awbNumber) {
  const data = await request('GET', `/api/awb/${awbNumber}/status`);
  const events = data.data || data.statusHistory || data;
  return (Array.isArray(events) ? events : []).map((e) => ({
    StatusDescription: e.status || e.StatusDescription || e.name || '',
    StatusDate: e.date || e.StatusDate || null,
    raw: e,
  }));
}

/** Descarca eticheta PDF pentru un AWB existent. */
async function getAwbPdf(awbNumber) {
  if (!cachedToken) await authenticate();
  const res = await fetch(`${getBaseUrl()}/api/awb/download/${awbNumber}`, {
    headers: { 'X-AUTH-TOKEN': cachedToken },
  });
  if (!res.ok) throw new Error(`Sameday: eroare ${res.status} la descărcarea etichetei PDF.`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Anuleaza (sterge) un AWB existent. */
async function deleteAwb(awbNumber) {
  return request('DELETE', `/api/awb/${awbNumber}`);
}

/**
 * Creeaza un AWB normal, de livrare de la noi catre client (retur Service ->
 * client, dupa reparatie). Diferit de createPickupAwb: aici NU se foloseste
 * thirdPartyPickup (ridicarea se face de la punctul nostru inregistrat,
 * comportamentul implicit al Sameday), doar awbRecipient = adresa clientului.
 * Foloseste serviciul standard "24H" (cod confirmat: "24").
 */
async function createForwardAwb(order) {
  const pickupPointId = await resolvePickupPointId();
  const services = await getServices();
  const service = services.find((s) => s.serviceCode === '24');
  if (!service) throw new Error('Sameday: serviciul "24H" nu este activ în cont.');

  const body = {
    pickupPoint: pickupPointId,
    packageType: 1,
    packageNumber: 1,
    packageWeight: 1,
    service: service.id,
    awbPayment: 1,
    cashOnDelivery: order.codAmount || 0,
    insuredValue: 0,
    thirdPartyPickup: false,
    awbRecipient: {
      name: order.shippingName,
      phoneNumber: order.shippingPhone,
      personType: 0,
      postalCode: order.shippingPostalCode,
      address: order.shippingAddress,
    },
    clientInternalReference: `${order.mpId}-${Date.now()}`,
    parcels: [{ weight: 1 }],
  };

  const data = await request('POST', '/api/awb', { body });
  return {
    trackingNumber: data.awbNumber,
    parcelId: data.awbNumber,
    raw: data,
  };
}

module.exports = {
  isConfigured,
  getBaseUrl,
  getServices,
  getPickupPoints,
  createPickupAwb,
  createForwardAwb,
  getAwbStatus,
  getAwbPdf,
  deleteAwb,
};
