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

  const body = {
    ...authBase(),
    WebshopEngine: c.webshopEngine,
    ParcelList: [parcel],
    PrintPosition: 1,
    ShowPrintDialog: false,
    TypeOfPrinter: 'A4_2x2',
  };

  const data = await callParcelService('PrintLabels', body);

  if (data.PrintLabelsErrorList && data.PrintLabelsErrorList.length) {
    const err = data.PrintLabelsErrorList[0];
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
  };
  const data = await callParcelService('GetPrintData', body);

  if (data.GetPrintDataErrorList && data.GetPrintDataErrorList.length) {
    const err = data.GetPrintDataErrorList[0];
    throw new Error(`GLS a refuzat cererea (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }
  if (!data.Pdfdocument) {
    throw new Error('GLS nu a întors nicio etichetă pentru acest colet.');
  }
  return Buffer.from(data.Pdfdocument, 'base64');
}

module.exports = { isConfigured, createParcel, deleteParcel, getParcelStatus, getLabelPdf, getBaseUrl };
