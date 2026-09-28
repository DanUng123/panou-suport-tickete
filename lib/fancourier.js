// Client pentru API-ul FAN Courier (selfAWB API v2.0, REST/JSON).
//
// Construit pe documentatia tehnica oficiala FAN Courier v2.0. Fara dependente
// npm -- doar fetch-ul nativ din Node.
//
// MULTI-COMPANIE: fiecare functie exportata primeste `company` (obiectul
// intors de db.getCompany(), cu credentialele companiei) ca prim argument.
// Tokenul se cacheaza PER COMPANIE, cu data lui reala de expirare, pe care
// FAN ne-o spune in raspunsul de autentificare.
//
// Ce e altfel la FAN fata de ceilalti curieri pe care ii avem:
//
// 1. Directia expedierii nu se da printr-un expeditor si un destinatar, ci
//    prin SERVICIU. Corpul cererii are un singur bloc de adresa, `recipient`,
//    care e mereu adresa clientului -- adica locul unde se duce curierul.
//    Cu serviciul obisnuit ("Standard") coletul pleaca de la noi catre el; cu
//    "Cont Colector" curierul merge la el si aduce coletul la noi. Asta e si
//    motivul pentru care nu exista un bloc `sender`: expeditorul e contul.
//
// 2. Contul are un `clientId` (codul de client din selfAWB) care insoteste
//    fiecare cerere, inclusiv citirile. Nu se poate deduce din API -- se ia
//    din contul selfAWB si se trece in Setari.

const ore = require('./ore-romanesti');

const BASE_URL = process.env.FAN_BASE_URL_OVERRIDE || 'https://api.fancourier.ro';

// Serviciul de livrare catre client si cel de ridicare de la client.
// „Cont Colector" e serviciul FAN prin care coletul se ridica de la adresa
// clientului si ajunge la noi -- exact ce inseamna un retur sau un service.
const SERVICIU_LIVRARE_IMPLICIT = 'Standard';
const SERVICIU_RIDICARE_IMPLICIT = 'Cont Colector';

function cfg(company) {
  return {
    username: company.fanUsername || '',
    password: company.fanPassword || '',
    clientId: company.fanClientId || '',
    serviciuLivrare: company.fanServiceForward || SERVICIU_LIVRARE_IMPLICIT,
    serviciuRidicare: company.fanServicePickup || SERVICIU_RIDICARE_IMPLICIT,
    formatEticheta: company.fanLabelFormat || 'A6',
  };
}

function isConfigured(company) {
  const c = cfg(company);
  return Boolean(c.username && c.password && c.clientId && company.fanActive !== false);
}

// ---------------------------------------------------------------- autentificare

// companyId -> { token, expira }
const tokenCache = new Map();

async function autentifica(company) {
  const c = cfg(company);
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ username: c.username, password: c.password }),
  });
  const text = await res.text();
  let date = null;
  try { date = JSON.parse(text); } catch (e) { /* raspuns care nu e JSON */ }
  if (!res.ok || !date || !date.data || !date.data.token) {
    const explicatie = res.status === 401 || res.status === 422 ? 'utilizator sau parolă greșite' : '';
    throw new Error(`FAN Courier: autentificare eșuată (${res.status}${explicatie ? `, ${explicatie}` : ''}): ${mesajEroare(date, text)}`);
  }
  // FAN ne spune chiar el pana cand e valabil tokenul; ne oprim cu un sfert de
  // ora mai devreme, ca sa nu prindem expirarea in mijlocul unei emiteri
  const expira = date.data.expiresAt
    ? new Date(ore.inUtcIso(date.data.expiresAt)).getTime() - 15 * 60 * 1000
    : Date.now() + 23 * 60 * 60 * 1000;
  tokenCache.set(company.id, { token: date.data.token, expira });
  return date.data.token;
}

async function token(company) {
  const cached = tokenCache.get(company.id);
  if (cached && cached.expira > Date.now()) return cached.token;
  return autentifica(company);
}

/** FAN raporteaza erorile in mai multe forme; le aducem la o singura propozitie. */
function mesajEroare(date, text) {
  if (!date) return (text || '').slice(0, 300);
  if (typeof date === 'string') return date.slice(0, 300);
  if (date.errors) {
    const bucati = [];
    const aduna = (val, cale) => {
      if (Array.isArray(val)) val.forEach((v) => aduna(v, cale));
      else if (val && typeof val === 'object') Object.entries(val).forEach(([k, v]) => aduna(v, cale ? `${cale}.${k}` : k));
      else bucati.push(cale ? `${cale}: ${val}` : String(val));
    };
    aduna(date.errors, '');
    if (bucati.length) return bucati.join('; ').slice(0, 300);
  }
  return String(date.message || date.error || JSON.stringify(date)).slice(0, 300);
}

/**
 * O cerere catre API, cu tokenul si clientId-ul atasate. La 401 reincercam o
 * singura data, cu token proaspat.
 */
async function cerere(company, method, cale, { body, query, asteptPdf } = {}, reincearcaLa401 = true) {
  if (!isConfigured(company)) {
    throw new Error('Integrarea FAN Courier nu este configurată pentru această companie (completați datele în Setări).');
  }
  const url = new URL(`${BASE_URL}${cale}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    // parametrii de tip lista se trimit repetat: awb[]=1&awb[]=2
    if (Array.isArray(v)) v.forEach((el) => url.searchParams.append(k, el));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${await token(company)}`,
      'Content-Type': 'application/json',
      'Accept': asteptPdf ? 'application/pdf' : 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 && reincearcaLa401) {
    tokenCache.delete(company.id);
    return cerere(company, method, cale, { body, query, asteptPdf }, false);
  }
  const tipContinut = res.headers.get('content-type') || '';
  if (asteptPdf && res.ok && tipContinut.includes('pdf')) {
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  let date = null;
  try { date = text ? JSON.parse(text) : null; } catch (e) { date = text; }
  if (!res.ok) throw new Error(`FAN Courier: ${method} ${cale} a răspuns ${res.status}: ${mesajEroare(date, text)}`);
  if (date && date.status === 'error') throw new Error(`FAN Courier: ${mesajEroare(date, text)}`);
  return date;
}

// ------------------------------------------------------------------- AWB-uri

/**
 * Adresa clientului, in forma ceruta de FAN.
 *
 * Strada si numarul se trimit separat. Noi avem adresa ca text liber, asa cum
 * a scris-o clientul in magazin, deci incercam sa desprindem numarul de la
 * final; daca nu reusim, trimitem totul ca strada -- FAN accepta si asa, iar
 * curierul citeste oricum adresa intreaga.
 */
function desparteAdresa(adresa) {
  const text = String(adresa || '').trim();
  if (!text) return { strada: '', numar: '' };

  // 1. „nr. 14" spune limpede care e numarul, oriunde ar fi in adresa
  const cuNr = text.match(/(^|[,;\s])nr\.?\s*(\d+[A-Za-z]?)/i);
  if (cuNr) {
    return { strada: text.slice(0, cuNr.index).replace(/[,;\s]+$/, '').trim() || text, numar: cuNr[2] };
  }

  // 2. Fara „nr.", un numar la final e numarul strazii -- DAR numai daca
  //    adresa nu contine bloc, scara, etaj sau apartament. Altfel „Aleea
  //    Teilor bl. C3 ap. 12" ar trimite apartamentul ca numar al strazii, iar
  //    curierul ar cauta o casa care nu exista.
  const areBlocSauApartament = /(^|[,;\s.])(bl|sc|et|ap)\b/i.test(text);
  if (!areBlocSauApartament) {
    const laFinal = text.match(/^(.*?)[,\s]+(\d+[A-Za-z]?)$/);
    if (laFinal) return { strada: laFinal[1].trim(), numar: laFinal[2] };
  }

  // 3. In rest o lasam intreaga: FAN accepta adresa ca strada, iar curierul
  //    citeste tot randul. Mai bine o adresa completa fara numar separat
  //    decat un numar gresit.
  return { strada: text, numar: '' };
}

function destinatar(client) {
  const { strada, numar } = desparteAdresa(client.adresa);
  return {
    name: client.nume || 'Client',
    contactPerson: client.nume || 'Client',
    phone: client.telefon || '',
    ...(client.email ? { email: client.email } : {}),
    address: {
      county: client.judet || '',
      locality: client.oras || '',
      street: strada || client.adresa || '',
      streetNo: numar,
      zipCode: client.codPostal || '',
    },
  };
}

/** Partea comuna a oricarei expedieri: colet, greutate, dimensiuni, plata. */
function informatiiColet({ serviciu, greutate, ramburs, observatie, continut }) {
  return {
    service: serviciu,
    packages: { parcel: 1, envelope: 0 },
    weight: Number(greutate) || 1,
    // FAN cere dimensiunile; pentru un colet obisnuit de magazin online,
    // valorile astea sunt o aproximare rezonabila si nu schimba tariful
    dimensions: { length: 20, width: 20, height: 10 },
    payment: 'expeditor', // transportul e in sarcina contului nostru
    ...(ramburs ? { cod: Number(ramburs) } : {}),
    ...(observatie ? { observation: observatie } : {}),
    content: continut || 'Produs',
  };
}

function numarAwbDinRaspuns(raspuns) {
  const lista = (raspuns && (raspuns.response || raspuns.data)) || [];
  const prima = Array.isArray(lista) ? lista[0] : lista;
  const awb = prima && (prima.awbNumber || prima.awb);
  if (!awb) throw new Error(`FAN Courier: nu am primit numărul AWB la creare (răspuns: ${JSON.stringify(raspuns).slice(0, 200)}).`);
  return String(awb);
}

/**
 * AWB de RIDICARE de la client: curierul merge la client si aduce coletul la
 * noi. La FAN asta se cere prin serviciul „Cont Colector", nu prin
 * inversarea adreselor.
 */
async function createPickupAwb(company, pickup) {
  const c = cfg(company);
  const body = {
    clientId: c.clientId,
    shipments: [{
      info: informatiiColet({
        serviciu: c.serviciuRidicare,
        greutate: pickup.weight,
        observatie: pickup.reason === 'retur' ? 'Retur produs' : 'Ridicare pentru service',
        continut: pickup.packageContent,
      }),
      recipient: destinatar({
        nume: pickup.customerName, adresa: pickup.address, oras: pickup.city,
        judet: pickup.county, codPostal: pickup.postalCode, telefon: pickup.phone, email: pickup.email,
      }),
    }],
  };
  const raspuns = await cerere(company, 'POST', '/intern-awb', { body });
  const awb = numarAwbDinRaspuns(raspuns);
  return {
    trackingNumber: awb,
    parcelId: awb, // la FAN totul se face pe numarul AWB
    labelPdf: await getLabelPdf(company, awb).catch(() => null),
    raw: raspuns,
  };
}

/** AWB de LIVRARE catre client: coletul pleaca de la noi. */
async function createForwardAwb(company, order) {
  const c = cfg(company);
  const body = {
    clientId: c.clientId,
    shipments: [{
      info: informatiiColet({
        serviciu: c.serviciuLivrare,
        greutate: order.weight,
        ramburs: order.codAmount,
        continut: order.packageContent,
      }),
      recipient: destinatar({
        nume: order.shippingName, adresa: order.shippingAddress, oras: order.shippingCity,
        judet: order.shippingState, codPostal: order.shippingPostalCode,
        telefon: order.shippingPhone, email: order.customerEmail,
      }),
    }],
  };
  const raspuns = await cerere(company, 'POST', '/intern-awb', { body });
  const awb = numarAwbDinRaspuns(raspuns);
  return {
    trackingNumber: awb,
    parcelId: awb,
    labelPdf: await getLabelPdf(company, awb).catch(() => null),
    raw: raspuns,
  };
}

/** Eticheta, ca PDF. */
async function getLabelPdf(company, awbNumber) {
  const c = cfg(company);
  const raspuns = await cerere(company, 'GET', '/awb/label', {
    query: { clientId: c.clientId, 'awbs[]': [String(awbNumber)], pdf: 1, format: c.formatEticheta, language: 'ro' },
    asteptPdf: true,
  });
  if (Buffer.isBuffer(raspuns)) return raspuns;
  // unele conturi primesc eticheta ca text base64, in loc de fisier
  const base64 = typeof raspuns === 'string' ? raspuns : (raspuns && (raspuns.data || raspuns.label));
  if (!base64 || typeof base64 !== 'string') throw new Error('FAN Courier: eticheta a venit goală.');
  return Buffer.from(base64, 'base64');
}

/**
 * Istoricul unui AWB, adus la aceeasi forma pe care o folosesc ceilalti
 * curieri -- asa interfata il afiseaza cu acelasi cod.
 */
async function getAwbStatus(company, awbNumber) {
  const c = cfg(company);
  const date = await cerere(company, 'GET', '/reports/awb/tracking', {
    query: { clientId: c.clientId, 'awb[]': [String(awbNumber)], language: 'ro' },
  });
  const lista = Array.isArray(date) ? date : ((date && (date.data || date.response)) || []);
  const evenimente = [];
  for (const expediere of (Array.isArray(lista) ? lista : [lista])) {
    for (const ev of ((expediere && expediere.events) || [])) {
      evenimente.push({
        StatusDescription: ev.name || ev.status || '',
        // FAN trimite ora romaneasca fara fus orar
        StatusDate: ev.date ? `/Date(${(ore.inMoment(ev.date) || new Date(ev.date)).getTime()})/` : null,
        DepotCity: ev.location || '',
        raw: ev,
      });
    }
  }
  return evenimente;
}

/** Anuleaza AWB-ul. FAN accepta anularea doar cat timp coletul n-a fost preluat. */
async function deleteAwb(company, awbNumber) {
  const c = cfg(company);
  await cerere(company, 'DELETE', '/awb', { query: { clientId: c.clientId, awb: String(awbNumber) } });
  return true;
}

/** Serviciile disponibile pe cont -- ca sa fie alese dintr-o lista in Setari, nu scrise de mana. */
async function getAvailableServices(company) {
  const date = await cerere(company, 'GET', '/reports/services', { query: { clientId: cfg(company).clientId } });
  const lista = Array.isArray(date) ? date : ((date && (date.data || date.response)) || []);
  return (Array.isArray(lista) ? lista : []).map((s) => ({
    nume: typeof s === 'string' ? s : (s.name || s.service || ''),
    raw: s,
  })).filter((s) => s.nume);
}

// FAN cere județ, localitate și stradă; codul poștal e opțional la ei.
const CAMPURI_RIDICARE_OBLIGATORII = ['adresa', 'oras', 'judet', 'telefon'];

module.exports = {
  isConfigured,
  CAMPURI_RIDICARE_OBLIGATORII,
  createPickupAwb,
  createForwardAwb,
  getAwbStatus,
  getLabelPdf,
  deleteAwb,
  getAvailableServices,
  desparteAdresa,
};
