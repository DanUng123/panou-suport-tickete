// Client pentru API-ul Cargus (Urgent Cargus API v3, REST/JSON).
//
// Construit pe documentatia tehnica oficiala publicata de Cargus
// (DocumentationAPIV3) si pe portalul lor de dezvoltatori. Fara dependente
// npm -- doar fetch-ul nativ din Node.
//
// MULTI-COMPANIE: fiecare functie exportata primeste `company` (obiectul
// intors de db.getCompany(), cu credentialele companiei) ca prim argument.
// Tokenul de autentificare se cacheaza PER COMPANIE -- altfel companiile ar
// ajunge sa foloseasca tokenul una alteia.
//
// Trei lucruri in care Cargus difera de ceilalti curieri pe care ii avem:
//
// 1. Autentificarea are DOUA chei, nu una: o cheie de abonament la portalul
//    lor (`Ocp-Apim-Subscription-Key`, fixa, legata de contul de dezvoltator)
//    si un token obtinut cu utilizator + parola, valabil 24 de ore.
//
// 2. Adresa destinatarului nu se trimite ca text liber: Cargus vrea ID-uri de
//    judet si de localitate din nomenclatorul lor. Le rezolvam din numele pe
//    care le avem in comanda, cu nomenclatorul citit si tinut in memorie.
//
// 3. Eticheta nu vine odata cu AWB-ul, ci se cere separat, si vine ca text
//    base64, nu ca fisier binar.

const ore = require('./ore-romanesti');

const BASE_URL = process.env.CARGUS_BASE_URL_OVERRIDE || 'https://urgentcargus.azure-api.net/api';

// Serviciul implicit: "Economic Standard", coletele pana in 31 kg -- acopera
// practic tot ce inseamna retur sau service dintr-un magazin online.
const SERVICIU_IMPLICIT = 34;

function cfg(company) {
  return {
    subscriptionKey: company.cargusSubscriptionKey || '',
    username: company.cargusUsername || '',
    password: company.cargusPassword || '',
    locationId: company.cargusLocationId || '',
    serviceId: Number(company.cargusServiceId) || SERVICIU_IMPLICIT,
    // 0 = A4, 1 = eticheta 10x14 (implicit, e formatul de imprimanta termica)
    labelFormat: company.cargusLabelFormat === 'a4' ? 0 : 1,
  };
}

function isConfigured(company) {
  const c = cfg(company);
  return Boolean(c.subscriptionKey && c.username && c.password && c.locationId && company.cargusActive !== false);
}

// ---------------------------------------------------------------- autentificare

// companyId -> { token, expira }
const tokenCache = new Map();

async function autentifica(company) {
  const c = cfg(company);
  const res = await fetch(`${BASE_URL}/LoginUser`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': c.subscriptionKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ UserName: c.username, Password: c.password }),
  });
  const text = await res.text();
  if (!res.ok) {
    const explicatie = res.status === 401
      ? 'utilizator sau parolă greșite'
      : res.status === 403 ? 'cheia de abonament (Subscription Key) e respinsă' : '';
    throw new Error(`Cargus: autentificare eșuată (${res.status}${explicatie ? `, ${explicatie}` : ''}): ${text.slice(0, 200)}`);
  }
  // raspunsul e tokenul, ca sir JSON cu ghilimele: "ABC123..."
  let token;
  try { token = JSON.parse(text); } catch (e) { token = text.trim().replace(/^"|"$/g, ''); }
  if (!token || typeof token !== 'string') throw new Error('Cargus: token lipsă din răspunsul de autentificare.');
  // tokenul e valabil 24 de ore; il reinnoim cu o ora mai devreme, ca sa nu
  // prindem expirarea chiar in mijlocul unei emiteri de AWB
  tokenCache.set(company.id, { token, expira: Date.now() + 23 * 60 * 60 * 1000 });
  return token;
}

async function token(company) {
  const cached = tokenCache.get(company.id);
  if (cached && cached.expira > Date.now()) return cached.token;
  return autentifica(company);
}

/**
 * O cerere catre API, cu token-ul atasat. La 401 reincercam o singura data,
 * cu token proaspat -- acopera cazul in care tokenul a expirat mai devreme
 * decat ne asteptam (sau a fost invalidat de partea lor).
 */
async function cerere(company, method, cale, { body, query } = {}, reincearcaLa401 = true) {
  if (!isConfigured(company)) {
    throw new Error('Integrarea Cargus nu este configurată pentru această companie (completați datele în Setări).');
  }
  const c = cfg(company);
  const url = new URL(`${BASE_URL}${cale}`);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Ocp-Apim-Subscription-Key': c.subscriptionKey,
      'Authorization': `Bearer ${await token(company)}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status === 401 && reincearcaLa401) {
    tokenCache.delete(company.id);
    return cerere(company, method, cale, { body, query }, false);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    throw new Error(`Cargus: ${method} ${cale} a răspuns ${res.status}: ${mesajEroare(data, text)}`);
  }
  return data;
}

/** Cargus raporteaza erorile in mai multe forme; le aducem la o singura propozitie. */
function mesajEroare(data, text) {
  if (!data) return (text || '').slice(0, 300);
  if (typeof data === 'string') return data.slice(0, 300);
  if (Array.isArray(data)) return data.map((e) => e.Message || e.message || JSON.stringify(e)).join('; ').slice(0, 300);
  return (data.Message || data.message || data.error || JSON.stringify(data)).slice(0, 300);
}

// ------------------------------------------------------------- nomenclatoare

/** Fara diacritice, fara prefixe administrative, litere mici -- ca sa se poata compara „Cluj-Napoca" cu „municipiul Cluj Napoca". */
function normalizeaza(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(judetul|judet|municipiul|municipiu|orasul|oras|comuna|satul|sat)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const cacheJudete = new Map();     // companyId -> [judete]
const cacheLocalitati = new Map(); // `${companyId}:${countyId}` -> [localitati]

async function getJudete(company) {
  if (cacheJudete.has(company.id)) return cacheJudete.get(company.id);
  const date = await cerere(company, 'GET', '/Counties', { query: { countryId: 1 } });
  const judete = Array.isArray(date) ? date : [];
  cacheJudete.set(company.id, judete);
  return judete;
}

async function getLocalitati(company, countyId) {
  const cheie = `${company.id}:${countyId}`;
  if (cacheLocalitati.has(cheie)) return cacheLocalitati.get(cheie);
  const date = await cerere(company, 'GET', '/Localities', { query: { countryId: 1, countyId } });
  const localitati = Array.isArray(date) ? date : [];
  cacheLocalitati.set(cheie, localitati);
  return localitati;
}

/**
 * Traduce „oras + judet", asa cum le avem noi din comanda, in perechea de
 * ID-uri pe care o cere Cargus.
 *
 * Judetul lipseste adesea din comenzi, iar atunci nu avem incotro: cautam
 * localitatea prin toate judetele. E costisitor o singura data -- pe urma
 * nomenclatorul ramane in memorie si raspunsul e instantaneu.
 */
async function rezolvaLocalitatea(company, oras, judet) {
  if (!oras) throw new Error('Cargus: lipsește orașul destinatarului.');
  const orasN = normalizeaza(oras);
  const judete = await getJudete(company);

  const potriviteJudet = judet
    ? judete.filter((j) => normalizeaza(j.Name) === normalizeaza(judet) || normalizeaza(j.Abbreviation || '') === normalizeaza(judet))
    : [];
  // intai judetul indicat de comanda, apoi restul -- ordinea asta face ca, in
  // cazul obisnuit, sa fie nevoie de o singura cerere
  const deCautat = potriviteJudet.length ? [...potriviteJudet, ...judete.filter((j) => !potriviteJudet.includes(j))] : judete;

  for (const j of deCautat) {
    const localitati = await getLocalitati(company, j.CountyId);
    const gasita = localitati.find((l) => normalizeaza(l.Name) === orasN)
      || localitati.find((l) => normalizeaza(l.Name).startsWith(orasN));
    if (gasita) {
      return {
        CountyId: j.CountyId,
        CountyName: j.Name,
        LocalityId: gasita.LocalityId,
        LocalityName: gasita.Name,
      };
    }
  }
  throw new Error(`Cargus: localitatea „${oras}"${judet ? ` (jud. ${judet})` : ''} nu există în nomenclatorul lor. Verifică scrierea orașului în comandă.`);
}

/** Punctele de ridicare ale contului -- din ele se alege expeditorul, in Setări. */
async function getPickupLocations(company) {
  const date = await cerere(company, 'GET', '/PickupLocations/GetForClient');
  return (Array.isArray(date) ? date : []).map((p) => ({
    id: p.LocationId,
    name: p.Name || p.LocationName || '',
    address: [p.AddressText, p.LocalityName, p.CountyName].filter(Boolean).join(', '),
    raw: p,
  }));
}

// ------------------------------------------------------------------- AWB-uri

/**
 * Cine plateste transportul.
 *
 * 1 = expeditorul, 2 = destinatarul. La o ridicare de la client (retur sau
 * service) expeditorul e clientul, iar plata e a noastra -- deci trece pe
 * destinatar. La o expediere obisnuita platim tot noi, dar acolo noi SUNTEM
 * expeditorul.
 */
const PLATITOR_EXPEDITOR = 1;
const PLATITOR_DESTINATAR = 2;

function adresaClient(client, localitate) {
  return {
    Name: client.nume || 'Client',
    CountyId: localitate.CountyId,
    CountyName: localitate.CountyName,
    LocalityId: localitate.LocalityId,
    LocalityName: localitate.LocalityName,
    StreetId: 0,
    StreetName: client.adresa || '',
    BuildingNumber: '',
    AddressText: client.adresa || '',
    ContactPerson: client.nume || 'Client',
    PhoneNumber: client.telefon || '',
    Email: client.email || '',
    CodPostal: client.codPostal || '',
  };
}

/**
 * AWB de RIDICARE de la client: coletul pleaca de la client catre noi.
 * Folosit pentru Service si Retur.
 */
async function createPickupAwb(company, pickup) {
  const c = cfg(company);
  const localitate = await rezolvaLocalitatea(company, pickup.city, pickup.county);
  const body = {
    Sender: adresaClient({
      nume: pickup.customerName, adresa: pickup.address, telefon: pickup.phone,
      email: pickup.email, codPostal: pickup.postalCode,
    }, localitate),
    Recipient: { LocationId: Number(c.locationId) },
    Parcels: 1,
    Envelopes: 0,
    TotalWeight: Number(pickup.weight) || 1,
    ServiceId: c.serviceId,
    DeclaredValue: 0,
    CashRepayment: 0,
    BankRepayment: 0,
    OpenPackage: false,
    SaturdayDelivery: false,
    MorningDelivery: false,
    ShipmentPayer: PLATITOR_DESTINATAR,
    Observations: pickup.reason === 'retur' ? 'Retur produs' : 'Ridicare pentru service',
    PackageContent: pickup.packageContent || 'Produs',
    SenderReference1: String(pickup.ticketId || ''),
    CustomString: String(pickup.ticketId || ''),
  };
  const raspuns = await cerere(company, 'POST', '/Awbs', { body });
  const awb = String(raspuns && raspuns.BarCode ? raspuns.BarCode : raspuns).replace(/"/g, '');
  if (!awb || awb === 'null') throw new Error(`Cargus: nu am primit numărul AWB la creare (răspuns: ${JSON.stringify(raspuns).slice(0, 200)}).`);
  return {
    trackingNumber: awb,
    parcelId: awb, // la Cargus totul se face pe codul de bare, nu exista un al doilea identificator
    labelPdf: await getLabelPdf(company, awb).catch(() => null),
    raw: raspuns,
  };
}

/**
 * AWB de LIVRARE catre client: coletul pleaca de la noi catre client.
 * Folosit pentru retrimiterea produsului dupa service.
 */
async function createForwardAwb(company, order) {
  const c = cfg(company);
  const localitate = await rezolvaLocalitatea(company, order.shippingCity, order.shippingState);
  const body = {
    Sender: { LocationId: Number(c.locationId) },
    Recipient: adresaClient({
      nume: order.shippingName, adresa: order.shippingAddress, telefon: order.shippingPhone,
      email: order.customerEmail, codPostal: order.shippingPostalCode,
    }, localitate),
    Parcels: 1,
    Envelopes: 0,
    TotalWeight: Number(order.weight) || 1,
    ServiceId: c.serviceId,
    DeclaredValue: 0,
    CashRepayment: Number(order.codAmount) || 0,
    BankRepayment: 0,
    OpenPackage: false,
    SaturdayDelivery: false,
    MorningDelivery: false,
    ShipmentPayer: PLATITOR_EXPEDITOR,
    Observations: '',
    PackageContent: order.packageContent || 'Produs',
    RecipientReference1: String(order.mpId || ''),
    CustomString: String(order.mpId || ''),
  };
  const raspuns = await cerere(company, 'POST', '/Awbs', { body });
  const awb = String(raspuns && raspuns.BarCode ? raspuns.BarCode : raspuns).replace(/"/g, '');
  if (!awb || awb === 'null') throw new Error(`Cargus: nu am primit numărul AWB la creare (răspuns: ${JSON.stringify(raspuns).slice(0, 200)}).`);
  return {
    trackingNumber: awb,
    parcelId: awb,
    labelPdf: await getLabelPdf(company, awb).catch(() => null),
    raw: raspuns,
  };
}

/** Eticheta, ca PDF. Cargus o trimite ca text base64, nu ca fisier. */
async function getLabelPdf(company, awbNumber) {
  const c = cfg(company);
  const raspuns = await cerere(company, 'GET', '/AwbDocuments', {
    query: {
      barCodes: JSON.stringify([String(awbNumber)]),
      type: 'PDF',
      format: c.labelFormat,
      printMainOnce: 0,
    },
  });
  const base64 = typeof raspuns === 'string' ? raspuns : (raspuns && (raspuns.FileContent || raspuns.Content));
  if (!base64) throw new Error('Cargus: eticheta a venit goală.');
  return Buffer.from(String(base64).replace(/^"|"$/g, ''), 'base64');
}

/**
 * Istoricul unui AWB, adus la aceeasi forma pe care o folosesc GLS si Sameday
 * -- asa interfata il afiseaza cu acelasi cod, fara nicio ramificatie.
 */
async function getAwbStatus(company, awbNumber) {
  const date = await cerere(company, 'GET', '/AwbTrace', { query: { barCode: String(awbNumber) } });
  const expedieri = Array.isArray(date) ? date : [date].filter(Boolean);
  const evenimente = [];
  for (const exp of expedieri) {
    for (const ev of (exp.Event || exp.Events || [])) {
      evenimente.push({
        StatusDescription: ev.Description || '',
        // Cargus trimite ora romaneasca fara fus orar; citita naiv, ar aparea
        // cu doua-trei ore mai tarziu decat s-a intamplat
        StatusDate: ev.Date ? `/Date(${(ore.inMoment(ev.Date) || new Date(ev.Date)).getTime()})/` : null,
        DepotCity: ev.LocalityName || '',
        raw: ev,
      });
    }
  }
  return evenimente;
}

/** Anuleaza AWB-ul. Cargus accepta anularea doar cat timp coletul n-a fost preluat. */
async function deleteAwb(company, awbNumber) {
  const raspuns = await cerere(company, 'DELETE', '/Awbs', { query: { barCode: String(awbNumber) } });
  if (raspuns === false || raspuns === 'false') {
    throw new Error('Cargus a refuzat anularea: AWB-ul nu există sau coletul a intrat deja în circuit (are înregistrări de scanare).');
  }
  return true;
}

// Cargus găsește adresa după județ și localitate, din nomenclatorul lor;
// codul poștal e opțional, deci nu-l cerem degeaba.
const CAMPURI_RIDICARE_OBLIGATORII = ['adresa', 'oras', 'telefon'];

module.exports = {
  isConfigured,
  CAMPURI_RIDICARE_OBLIGATORII,
  getPickupLocations,
  rezolvaLocalitatea,
  createPickupAwb,
  createForwardAwb,
  getAwbStatus,
  getLabelPdf,
  deleteAwb,
};
