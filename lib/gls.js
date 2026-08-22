// Client pentru MyGLS API (REST/JSON) -- sistemul folosit acum de GLS in
// Romania, Ungaria, Cehia, Slovacia, Croatia, Slovenia, Serbia.
// Construit pe baza documentatiei oficiale "MyGLS API for system
// integration" (versiunea 25.12.11), obtinuta de la api.mygls.hu/docs/.
//
// Foloseste doar fetch + crypto native din Node -- fara dependente npm.
//
// Necesita variabile de mediu:
//   GLS_USERNAME, GLS_PASSWORD, GLS_CLIENT_NUMBER  -- credentialele MyGLS
//   GLS_SENDER_NAME, GLS_SENDER_STREET, GLS_SENDER_HOUSE_NUMBER,
//   GLS_SENDER_CITY, GLS_SENDER_ZIPCODE, GLS_SENDER_CONTACT,
//   GLS_SENDER_PHONE, GLS_SENDER_EMAIL  -- datele firmei tale (expeditor)
//   GLS_SENDER_COUNTRY   -- optional, implicit "RO"
//   GLS_COUNTRY_CODE     -- optional, implicit "RO" (cod tara MyGLS)
//   GLS_ENVIRONMENT      -- optional, "production" (implicit) sau "test"
//   GLS_WEBSHOP_ENGINE   -- optional, implicit "Custom"

const crypto = require('crypto');

function cfg() {
  return {
    username: process.env.GLS_USERNAME || '',
    password: process.env.GLS_PASSWORD || '',
    clientNumber: process.env.GLS_CLIENT_NUMBER || '',
    countryCode: (process.env.GLS_COUNTRY_CODE || 'RO').toUpperCase(),
    environment: (process.env.GLS_ENVIRONMENT || 'production').toLowerCase(),
    webshopEngine: process.env.GLS_WEBSHOP_ENGINE || 'Custom',
    typeOfPrinter: process.env.GLS_TYPE_OF_PRINTER || 'Connect',
    senderName: process.env.GLS_SENDER_NAME || '',
    senderAddress: process.env.GLS_SENDER_ADDRESS || '',
    senderCity: process.env.GLS_SENDER_CITY || '',
    senderZipcode: process.env.GLS_SENDER_ZIPCODE || '',
    senderCountry: process.env.GLS_SENDER_COUNTRY || 'RO',
    senderContact: process.env.GLS_SENDER_CONTACT || '',
    senderPhone: process.env.GLS_SENDER_PHONE || '',
    senderEmail: process.env.GLS_SENDER_EMAIL || '',
  };
}

function isConfigured() {
  const c = cfg();
  return Boolean(
    c.username && c.password && c.clientNumber &&
    c.senderName && c.senderAddress && c.senderCity && c.senderZipcode
  );
}

// tarile suportate de MyGLS si domeniul lor (vezi "Country domain API URLs" din doc)
const COUNTRY_DOMAINS = {
  RO: 'mygls.ro', HU: 'mygls.hu', CZ: 'mygls.cz', SK: 'mygls.sk',
  HR: 'mygls.hr', SI: 'mygls.si', RS: 'mygls.rs',
};

function getBaseUrl() {
  if (process.env.GLS_BASE_URL) return process.env.GLS_BASE_URL;
  const c = cfg();
  const domain = COUNTRY_DOMAINS[c.countryCode] || COUNTRY_DOMAINS.RO;
  const sub = c.environment === 'test' ? 'api.test' : 'api';
  return `https://${sub}.${domain}`;
}

function authBase() {
  const c = cfg();
  const hash = crypto.createHash('sha512').update(c.password, 'utf-8').digest();
  return {
    Username: c.username,
    Password: Array.from(hash), // byte[] C# -> array JSON de intregi 0-255
  };
}

/** Formatul de data folosit de MyGLS (stil ASP.NET JSON): /Date(<ms epoca>)/ */
function toGlsDate(date) {
  return `/Date(${date.getTime()})/`;
}

async function callParcelService(method, body) {
  if (!isConfigured()) {
    throw new Error('Integrarea GLS nu este configurată (variabile de mediu lipsă).');
  }
  const url = `${getBaseUrl()}/ParcelService.svc/json/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data = null;
  try { data = await res.json(); } catch (e) { /* fara body / body invalid */ }

  if (!res.ok) {
    const msg = (data && data.Message) || `Eroare HTTP de la GLS (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function buildAddress({ name, street, city, zipcode, country, contactName, contactPhone, contactEmail }) {
  return {
    Name: name || '',
    Street: street || '',
    HouseNumber: '',
    City: city || '',
    ZipCode: zipcode || '',
    CountryIsoCode: (country || 'RO').toUpperCase(),
    ContactName: contactName || name || '',
    ContactPhone: contactPhone || '',
    ContactEmail: contactEmail || '',
  };
}

/**
 * Genereaza AWB (PrintLabels -- combina PrepareLabels + GetPrintedLabels
 * intr-un singur apel, conform documentatiei oficiale).
 *
 * order: { mpId, codAmount, currency, shippingName, shippingStreet,
 *          shippingHouseNumber, shippingCity, shippingPostalCode,
 *          shippingPhone, customerEmail }
 *
 * Intoarce { trackingNumber, parcelId, labelPdf (Buffer) } sau arunca
 * eroare cu mesajul exact primit de la GLS.
 */
/**
 * Cauta un colet deja creat la GLS, dupa referinta clientului (ClientReference),
 * folosind GetParcelList (interogare pe interval de date).
 * Folosit ca recuperare cand GLS raspunde "eticheta deja generata" (cod 18),
 * dar aplicatia locala nu a apucat sa salveze rezultatul initial.
 */
async function findByClientReference(clientReference, daysBack = 30) {
  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const body = {
    ...authBase(),
    PickupDateFrom: toGlsDate(from),
    PickupDateTo: toGlsDate(now),
    PrintDateFrom: toGlsDate(from),
    PrintDateTo: toGlsDate(now),
  };
  const data = await callParcelService('GetParcelList', body);

  if (data.GetParcelListErrors && data.GetParcelListErrors.length) {
    const err = data.GetParcelListErrors[0];
    throw new Error(`GLS a refuzat interogarea de recuperare (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }

  const list = data.PrintDataInfoList || [];
  const match = list.find((p) => {
    const ref = p.ClientReference ?? p.Parcel?.ClientReference;
    return String(ref) === String(clientReference);
  });

  if (!match) {
    // diagnostic: aratam exact ce a intors GLS, ca sa intelegem de ce nu s-a gasit potrivirea
    const refsSeen = list.map((p) => p.ClientReference ?? p.Parcel?.ClientReference ?? '(fara referinta)');
    const diag = list.length
      ? `Am găsit ${list.length} colet(e) recente la GLS, dar niciunul cu referința "${clientReference}". Referințe văzute: ${refsSeen.slice(0, 20).join(', ')}${refsSeen.length > 20 ? '…' : ''}`
      : `GLS nu a întors niciun colet recent (0 rezultate) pentru interogarea de recuperare.`;
    const diagError = new Error(diag);
    diagError.diagnostic = true;
    diagError.rawList = list;
    throw diagError;
  }

  return match;
}

/**
 * Functie generica de creare colet la GLS (PrintLabels), cu recuperare
 * automata la eroarea "deja generat" (cod 18). Folosita atat pentru
 * livrare catre client, cat si pentru ridicare de la client (Pick & Ship /
 * Pick & Return).
 *
 * parcelFields: obiectul Parcel complet (ClientReference, PickupAddress,
 *   DeliveryAddress, ServiceList etc.) -- vezi createParcel/createPickupAwb.
 */
async function _printLabel(parcelFields) {
  const c = cfg();
  const body = {
    ...authBase(),
    WebshopEngine: c.webshopEngine,
    ParcelList: [parcelFields],
    PrintPosition: 1,
    ShowPrintDialog: false,
    TypeOfPrinter: c.typeOfPrinter,
  };

  const data = await callParcelService('PrintLabels', body);

  if (data.PrintLabelsErrorList && data.PrintLabelsErrorList.length) {
    const err = data.PrintLabelsErrorList[0];

    // cod 18 = "Parcel label is already generated" -- GLS a creat deja
    // coletul (probabil la o incercare anterioara), dar noi n-am apucat
    // sa salvam local rezultatul. Recuperam datele in loc sa esuam.
    if (Number(err.ErrorCode) === 18) {
      let existing;
      try {
        existing = await findByClientReference(parcelFields.ClientReference);
      } catch (diagErr) {
        throw new Error(`GLS spune că eticheta e deja generată, dar recuperarea automată a eșuat: ${diagErr.message}`);
      }
      if (existing) {
        return {
          trackingNumber: String(existing.ParcelNumber),
          parcelId: existing.ParcelId,
          labelPdf: null, // se poate re-extrage oricand prin getLabelPdf(parcelId)
          recovered: true,
        };
      }
    }

    throw new Error(`GLS a refuzat cererea (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }
  if (!data.PrintLabelsInfoList || !data.PrintLabelsInfoList.length) {
    throw new Error('GLS nu a întors niciun colet generat. Răspuns neașteptat.');
  }
  if (!data.Labels) {
    throw new Error('GLS a generat coletul, dar nu a întors eticheta PDF.');
  }

  const info = data.PrintLabelsInfoList[0];
  return {
    trackingNumber: String(info.ParcelNumber),
    parcelId: info.ParcelId,
    labelPdf: Buffer.from(data.Labels, 'base64'),
  };
}

async function createParcel(order) {
  const c = cfg();

  const deliveryAddress = buildAddress({
    name: order.shippingName,
    street: order.shippingAddress,
    city: order.shippingCity,
    zipcode: order.shippingPostalCode,
    country: 'RO',
    contactName: order.shippingName,
    contactPhone: order.shippingPhone,
    contactEmail: order.customerEmail,
  });

  const pickupAddress = buildAddress({
    name: c.senderName,
    street: c.senderAddress,
    city: c.senderCity,
    zipcode: c.senderZipcode,
    country: c.senderCountry,
    contactName: c.senderContact,
    contactPhone: c.senderPhone,
    contactEmail: c.senderEmail,
  });

  const parcel = {
    ClientNumber: Number(c.clientNumber),
    ClientReference: String(order.mpId),
    Count: 1,
    Content: `Comanda #${order.mpId}`,
    PickupDate: toGlsDate(new Date()),
    PickupAddress: pickupAddress,
    DeliveryAddress: deliveryAddress,
  };

  if (order.codAmount && order.codAmount > 0) {
    parcel.CODAmount = order.codAmount;
    parcel.CODReference = String(order.mpId);
    parcel.CODCurrency = order.currency || 'RON';
  }

  return _printLabel(parcel);
}

/**
 * Genereaza un AWB de RIDICARE de la client (curierul merge la client,
 * aduce coletul la firma) -- foloseste serviciile GLS "Pick & Ship" (PSS,
 * pentru service/reparatii) sau "Pick & Return" (PRS, pentru retur).
 *
 * pickup: { ticketId, reason ('service'|'retur'), customerName, address,
 *           city, postalCode, phone, email }
 */
async function createPickupAwb(pickup) {
  const c = cfg();
  // TODO: pentru pickup.reason === 'schimb' (Colet la Schimb), GLS ar putea avea
  // un cod de serviciu dedicat pentru ridicare+livrare in aceeasi vizita (posibil "CS1",
  // neconfirmat oficial). Pana la confirmare cu GLS, folosim acelasi PSS ca la "service"
  // (AWB standard, fara serviciu special) -- schimbati doar linia de mai jos cand se confirma.
  const serviceCode = pickup.reason === 'retur' ? 'PRS' : 'PSS';

  // in sensul invers: adresa clientului devine PICKUP, adresa firmei devine DELIVERY
  const pickupAddress = buildAddress({
    name: pickup.customerName,
    street: pickup.address,
    city: pickup.city,
    zipcode: pickup.postalCode,
    country: 'RO',
    contactName: pickup.customerName,
    contactPhone: pickup.phone,
    contactEmail: pickup.email,
  });

  const deliveryAddress = buildAddress({
    name: c.senderName,
    street: c.senderAddress,
    city: c.senderCity,
    zipcode: c.senderZipcode,
    country: c.senderCountry,
    contactName: c.senderContact,
    contactPhone: c.senderPhone,
    contactEmail: c.senderEmail,
  });

  const parcel = {
    ClientNumber: Number(c.clientNumber),
    ClientReference: String(pickup.ticketId),
    Count: 1,
    Content: `Ridicare ${{ retur: 'retur', schimb: 'colet la schimb' }[pickup.reason] || 'service'} — ${pickup.ticketId}`,
    PickupDate: toGlsDate(new Date()),
    PickupAddress: pickupAddress,
    DeliveryAddress: deliveryAddress,
    ServiceList: [{ Code: serviceCode }],
  };

  return _printLabel(parcel);
}

/** Anuleaza un colet deja creat, pe baza parcelId (NU tracking number). */
async function deleteParcel(parcelId) {
  const body = {
    ...authBase(),
    ParcelIdList: [Number(parcelId)],
  };
  const data = await callParcelService('DeleteLabels', body);

  if (data.DeleteLabelsErrorList && data.DeleteLabelsErrorList.length) {
    const err = data.DeleteLabelsErrorList[0];
    throw new Error(`GLS a refuzat anularea (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }
  return { success: true };
}

/** Extrage statusul curent al unui colet, pe baza numarului AWB (tracking number). */
async function getParcelStatus(trackingNumber) {
  const body = {
    ...authBase(),
    ParcelNumber: Number(trackingNumber),
    ReturnPOD: false,
    LanguageIsoCode: 'RO',
  };
  const data = await callParcelService('GetParcelStatuses', body);

  if (data.GetParcelStatusErrors && data.GetParcelStatusErrors.length) {
    const err = data.GetParcelStatusErrors[0];
    throw new Error(`GLS a refuzat cererea (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }
  return data.ParcelStatusList || [];
}

/** Re-extrage eticheta PDF pentru un colet deja creat, pe baza parcelId (nu tracking number). */
async function getLabelPdf(parcelId) {
  const body = {
    ...authBase(),
    ParcelIdList: [Number(parcelId)],
    PrintPosition: 1,
    ShowPrintDialog: false,
    TypeOfPrinter: cfg().typeOfPrinter,
  };
  const data = await callParcelService('GetPrintedLabels', body);

  if (data.GetPrintedLabelsErrorList && data.GetPrintedLabelsErrorList.length) {
    const err = data.GetPrintedLabelsErrorList[0];
    throw new Error(`GLS a refuzat cererea (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }
  if (!data.Labels) {
    throw new Error('GLS nu a întors nicio etichetă pentru acest colet.');
  }
  return Buffer.from(data.Labels, 'base64');
}

module.exports = { isConfigured, createParcel, createPickupAwb, deleteParcel, getParcelStatus, getLabelPdf, findByClientReference, getBaseUrl };
