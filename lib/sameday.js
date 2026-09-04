// Client pentru API-ul Sameday Courier (REST/JSON).
// Construit pe baza SDK-ului PHP oficial (github.com/sameday-courier/php-sdk)
// si a fragmentelor de documentatie oficiala gasite -- API-ul propriu-zis
// Sameday nu publica un URL de productie predictibil (e primit individual
// de la echipa lor), asa ca acesta se configureaza explicit.
//
// MULTI-COMPANIE: fiecare functie exportata primeste acum `company` (obiectul
// intors de db.getCompany(), cu credentialele companiei) ca prim argument.
// IMPORTANT: tokenul de autentificare Sameday se cacheaza acum PER COMPANIE
// (nu mai e un singur token global) -- altfel companiile ar ajunge sa
// foloseasca tokenul una alteia.
//
// Ramase globale (env, optionale, identice pt toate companiile -- setari
// tehnice, nu credentiale): SAMEDAY_ENVIRONMENT, SAMEDAY_BASE_URL_PRODUCTION,
// SAMEDAY_BASE_URL_TEST.

function cfg(company) {
  return {
    username: company.samedayUsername || '',
    password: company.samedayPassword || '',
    pickupPointId: company.samedayPickupPointId || '',
    pickupPointAddress: company.samedayPickupPointAddress || '',
    contactPersonId: company.samedayContactPersonId || '',
    environment: (process.env.SAMEDAY_ENVIRONMENT || 'production').toLowerCase(),
    senderName: company.samedaySenderName || '',
    senderPhone: company.samedaySenderPhone || '',
    senderPostalCode: company.samedaySenderPostalCode || '',
    senderAddress: company.samedaySenderAddress || '',
  };
}

function isConfigured(company) {
  const c = cfg(company);
  const hasPickupPoint = Boolean(c.pickupPointId || c.pickupPointAddress);
  return Boolean(c.username && c.password && hasPickupPoint && company.samedayActive !== false);
}

function getBaseUrl(company) {
  const c = cfg(company);
  if (c.environment === 'test') {
    return process.env.SAMEDAY_BASE_URL_TEST || 'https://sameday-api.demo.zitec.com';
  }
  return process.env.SAMEDAY_BASE_URL_PRODUCTION || 'https://api.sameday.ro';
}

// token-ul de autentificare, cacheat PER COMPANIE (cheia = company.id).
// valabil o perioada, nu stim exact cat -- il reinnoim daca primim 401.
const tokenCache = new Map(); // companyId -> token

async function authenticate(company) {
  const c = cfg(company);
  const res = await fetch(`${getBaseUrl(company)}/api/authenticate`, {
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
  tokenCache.set(company.id, token);
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

async function request(company, method, path, { body, query } = {}, retryOn401 = true) {
  let token = tokenCache.get(company.id);
  if (!token) token = await authenticate(company);

  let url = `${getBaseUrl(company)}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'X-AUTH-TOKEN': token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retryOn401) {
    tokenCache.delete(company.id);
    await authenticate(company);
    return request(company, method, path, { body, query }, false);
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
async function getServices(company) {
  const data = await request(company, 'GET', '/api/client/services');
  return data.data || data.services || data;
}

/** Lista punctelor de ridicare configurate pentru cont. */
async function getPickupPoints(company) {
  const data = await request(company, 'GET', '/api/client/pickup-points');
  return data.data || data.pickupPoints || data;
}

function normalizeRoName(s) {
  return String(s || '').toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i').replace(/ș/g, 's').replace(/ş/g, 's').replace(/ț/g, 't').replace(/ţ/g, 't')
    .trim();
}

function normalizeAddr(s) {
  return normalizeRoName(s).replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Identifica automat punctul de ridicare configurat.
 * Prioritate: company.samedayPickupPointId explicit (cel mai sigur) >
 * potrivire dupa adresa configurata (company.samedayPickupPointAddress) >
 * singurul punct marcat "defaultPickupPoint".
 */
async function resolvePickupPointId(company) {
  const c = cfg(company);
  if (c.pickupPointId) return Number(c.pickupPointId);
  const points = await getPickupPoints(company);
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
    throw new Error(`Sameday: nu am găsit niciun punct de ridicare care să corespundă adresei configurate ("${c.pickupPointAddress}"). Puncte disponibile: ${list}. Poți seta direct ID-ul punctului de ridicare în Setări.`);
  }
  return match.id;
}

/**
 * Rezolva ID-ul persoanei de contact de la punctul de ridicare (optional,
 * dar recomandat). Prioritate: company.samedayContactPersonId explicit >
 * persoana implicita (defaultContactPerson) de la punctul de ridicare folosit.
 */
async function resolveContactPersonId(company) {
  const c = cfg(company);
  if (c.contactPersonId) return Number(c.contactPersonId);
  try {
    const pickupId = await resolvePickupPointId(company);
    const points = await getPickupPoints(company);
    const point = points.find((p) => p.id === pickupId);
    const contacts = point?.pickupPointContactPerson || [];
    const contact = contacts.find((cp) => cp.defaultContactPerson) || contacts[0];
    return contact?.id || null;
  } catch (e) {
    return null; // optional -- nu blocam crearea AWB-ului daca nu poate fi rezolvata
  }
}

/** Lista judetelor (pentru rezolvarea adresei destinatarului la ID numeric). */
async function getCounties(company, countryCode = 'RO') {
  const data = await request(company, 'GET', '/api/geolocation/county', { query: { countryCode } });
  return data.data || data.counties || data;
}

/** Lista localitatilor dintr-un judet (id-ul judetului obtinut din getCounties). */
async function getCities(company, countyId) {
  const data = await request(company, 'GET', '/api/geolocation/city', { query: { countyId } });
  return data.data || data.cities || data;
}

async function resolveCountyAndCityIds(company, countyName, cityName) {
  const counties = await getCounties(company);
  const county = counties.find((c) => normalizeRoName(c.name) === normalizeRoName(countyName));
  if (!county) throw new Error(`Sameday: județul "${countyName}" nu a fost găsit în nomenclatorul Sameday.`);
  const cities = await getCities(company, county.id);
  const city = cities.find((c) => normalizeRoName(c.name) === normalizeRoName(cityName));
  if (!city) throw new Error(`Sameday: localitatea "${cityName}" nu a fost găsită în județul "${countyName}" (nomenclator Sameday).`);
  return { countyId: county.id, cityId: city.id };
}

/**
 * Creeaza un AWB de ridicare de la client (Service/Retur/Colet la schimb).
 * Structura cererii de mai jos e CONFIRMATA printr-un apel real catre
 * productie (22-23.08.2026).
 *
 * @param {{reason: 'service'|'retur'|'schimb', customerName, address, city, postalCode, phone, email, ticketId}} pickup
 */
async function createPickupAwb(company, pickup) {
  const pickupPointId = await resolvePickupPointId(company);
  const contactPersonId = await resolveContactPersonId(company);
  const services = await getServices(company);
  const serviceCode = pickup.reason === 'schimb' ? '24' : 'RS';
  const service = services.find((s) => s.serviceCode === serviceCode);
  if (!service) throw new Error(`Sameday: serviciul "${serviceCode}" nu este activ în cont. Servicii disponibile: ${services.map((s) => `${s.serviceCode} (${s.name})`).join(', ')}`);
  const c = cfg(company);
  if (!c.senderName || !c.senderPhone || !c.senderPostalCode || !c.senderAddress) {
    throw new Error('Sameday: datele voastre de contact (expeditor) nu sunt configurate în Setări.');
  }

  let body;
  if (pickup.reason === 'schimb') {
    // COLET LA SCHIMB: confirmat printr-un test manual real, direct din panoul
    // Sameday (23.08.2026) -- AWB-ul principal e o LIVRARE NORMALA catre client
    // (fara thirdParty deloc!). Taxa SWAP declanseaza generarea AUTOMATA, de
    // catre Sameday, a unui al doilea AWB cu ridicarea inversata corect (terț
    // = clientul, destinatar = noi) -- NU trebuie setat thirdParty manual, ar
    // produce rezultatul gresit (confirmat printr-un test API anterior).
    body = {
      pickupPoint: pickupPointId,
      ...(contactPersonId ? { contactPerson: contactPersonId } : {}),
      packageType: 0, // 714230 (SWAP) e confirmat pt packageType 0
      packageNumber: 1,
      packageWeight: 1,
      service: service.id,
      awbPayment: 1,
      cashOnDelivery: 0,
      insuredValue: 0,
      thirdPartyPickup: "0",
      awbRecipient: {
        name: pickup.customerName,
        phoneNumber: pickup.phone,
        personType: 0,
        postalCode: pickup.postalCode,
        address: pickup.address,
      },
      serviceTaxes: [714230],
      clientInternalReference: `${pickup.ticketId}-${Date.now()}`,
      parcels: [{ weight: 1 }],
    };
  } else {
    // Service/Retur: ridicare reala de la client, fara AWB auto-generat --
    // aici thirdParty e necesar, confirmat printr-un test real anterior.
    body = {
      pickupPoint: pickupPointId,
      ...(contactPersonId ? { contactPerson: contactPersonId } : {}),
      packageType: 1,
      packageNumber: 1,
      packageWeight: 1,
      service: service.id,
      awbPayment: 1,
      cashOnDelivery: 0,
      insuredValue: 0,
      thirdPartyPickup: "1",
      thirdParty: {
        name: pickup.customerName,
        phoneNumber: pickup.phone,
        personType: 0,
        postalCode: pickup.postalCode,
        address: pickup.address,
      },
      awbRecipient: {
        name: c.senderName,
        phoneNumber: c.senderPhone,
        personType: 0,
        postalCode: c.senderPostalCode,
        address: c.senderAddress,
      },
      clientInternalReference: `${pickup.ticketId}-${Date.now()}`,
      parcels: [{ weight: 1 }],
    };
  }

  const data = await request(company, 'POST', '/api/awb', { body });
  return {
    trackingNumber: data.awbNumber || data.data?.awbNumber,
    parcelId: data.awbNumber || data.data?.awbNumber,
    secondaryAwbNumber: data.returnAwbs?.[0]?.awbNumber || null,
    raw: data,
  };
}

/**
 * Urmarire status AWB. Documentatia oficiala Sameday NU prevede un endpoint
 * per-AWB individual, ci unul de sincronizare pe interval de timp (max 2 ore).
 */
/**
 * Istoricul complet de status, pentru UN SINGUR AWB -- CONFIRMAT LIVE cu
 * contul real: GET /api/client/parcel/{awbNumber}/status-history,
 * campul "parcelHistory" contine toate evenimentele. Contrazice raspunsul
 * initial al suportului tehnic Sameday (care spusese ca nu exista un
 * astfel de endpoint) -- gasit prin campul "parcelDetails" din raspunsul
 * status-sync, care indica exact acest URL.
 */
async function getAwbStatus(company, awbNumber) {
  const data = await request(company, 'GET', `/api/client/parcel/${awbNumber}/status-history`);
  const history = data.parcelHistory || [];
  return history.map((e) => ({
    StatusDescription: e.statusLabel || e.status || '',
    // Sameday intoarce data ca text ISO simplu (ex: "2026-09-04T16:58:04+03:00")
    // -- o transformam in acelasi format "/Date(N)/" folosit de GLS, ca sa
    // functioneze cu acelasi cod de afisare din interfata, fara modificari
    StatusDate: e.statusDate ? `/Date(${new Date(e.statusDate).getTime()})/` : null,
    DepotCity: e.transitLocation || e.county || '',
    raw: e,
  }));
}

/**
 * Preia TOATE schimbarile de status recente, pentru tot contul (nu
 * filtrate pe un AWB anume) -- folosita de job-ul de fundal, care le
 * salveaza in propria baza de date, construind astfel un istoric complet
 * in timp. Necesar deoarece Sameday NU ofera un endpoint de interogare
 * dupa un singur AWB (confirmat direct de suportul lor tehnic) -- doar
 * acest tip de interogare pe fereastra de timp (max 2 ore).
 */
async function pollRecentStatusChanges(company) {
  const now = Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const data = await request(company, 'GET', '/api/client/status-sync', {
    query: {
      startTimestamp: Math.floor(twoHoursAgo / 1000),
      endTimestamp: Math.floor(now / 1000),
      page: 1,
      countPerPage: 500,
    },
  });
  const allEvents = data.data || data.items || (Array.isArray(data) ? data : []);
  return allEvents.map((e) => ({
    awbNumber: String(e.awbNumber || e.awb || ''),
    statusDescription: e.status || e.StatusDescription || e.statusName || e.description || '',
    statusDate: e.date || e.StatusDate || e.timestamp || null,
    raw: e,
  })).filter((e) => e.awbNumber);
}

/** Descarca eticheta PDF pentru un AWB existent. */
async function getAwbPdf(company, awbNumber) {
  let token = tokenCache.get(company.id);
  if (!token) token = await authenticate(company);
  // format A4/A6, ales de companie -- CONFIRMAT direct de suportul tehnic
  // Sameday (app.support@sameday.ro), testat live cu date reale:
  // GET /api/awb/download/{awbNumber}/{format}/pdf, format implicit A4
  const format = company.samedayAwbPdfFormat === 'A6' ? 'A6' : 'A4';
  const res = await fetch(`${getBaseUrl(company)}/api/awb/download/${awbNumber}/${format}/pdf`, {
    headers: { 'X-AUTH-TOKEN': token },
  });
  if (!res.ok) throw new Error(`Sameday: eroare ${res.status} la descărcarea etichetei PDF.`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Anuleaza (sterge) un AWB existent. */
async function deleteAwb(company, awbNumber) {
  return request(company, 'DELETE', `/api/awb/${awbNumber}`);
}

/**
 * Creeaza un AWB normal, de livrare de la noi catre client (retur Service ->
 * client, dupa reparatie). Foloseste serviciul standard "24H".
 */
async function createForwardAwb(company, order) {
  const pickupPointId = await resolvePickupPointId(company);
  const contactPersonId = await resolveContactPersonId(company);
  const services = await getServices(company);
  const service = services.find((s) => s.serviceCode === '24');
  if (!service) throw new Error('Sameday: serviciul "24H" nu este activ în cont.');
  const body = {
    pickupPoint: pickupPointId,
    ...(contactPersonId ? { contactPerson: contactPersonId } : {}),
    packageType: 1,
    packageNumber: 1,
    packageWeight: 1,
    service: service.id,
    awbPayment: 1,
    cashOnDelivery: order.codAmount || 0,
    insuredValue: 0,
    thirdPartyPickup: "0",
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
  const data = await request(company, 'POST', '/api/awb', { body });
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
  pollRecentStatusChanges,
  getAwbPdf,
  deleteAwb,
};
