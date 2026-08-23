// Client pentru MyGLS API (REST/JSON) -- sistemul folosit acum de GLS in
// Romania, Ungaria, Cehia, Slovacia, Croatia, Slovenia, Serbia.
// Construit pe baza documentatiei oficiale "MyGLS API for system
// integration" (versiunea 25.12.11), obtinuta de la api.mygls.hu/docs/.
//
// Foloseste doar fetch + crypto native din Node -- fara dependente npm.
//
// MULTI-COMPANIE: fiecare functie exportata primeste acum `company` (obiectul
// intors de db.getCompany(), cu credentialele companiei) ca prim argument, in
// loc sa citeasca variabile de mediu globale. Ramase globale (env, optionale,
// identice pt toate companiile -- setari tehnice, nu credentiale):
//   GLS_COUNTRY_CODE, GLS_ENVIRONMENT, GLS_WEBSHOP_ENGINE,
//   GLS_TYPE_OF_PRINTER, GLS_BASE_URL
const crypto = require('crypto');

function cfg(company) {
  return {
    username: company.glsUsername || '',
    password: company.glsPassword || '',
    clientNumber: company.glsClientNumber || '',
    countryCode: (process.env.GLS_COUNTRY_CODE || 'RO').toUpperCase(),
    environment: (process.env.GLS_ENVIRONMENT || 'production').toLowerCase(),
    webshopEngine: process.env.GLS_WEBSHOP_ENGINE || 'Custom',
    typeOfPrinter: process.env.GLS_TYPE_OF_PRINTER || 'Connect',
    senderName: company.glsSenderName || '',
    senderAddress: company.glsSenderAddress || '',
    senderCity: company.glsSenderCity || '',
    senderZipcode: company.glsSenderZipcode || '',
    senderCountry: 'RO',
    senderContact: company.glsSenderContact || '',
    senderPhone: company.glsSenderPhone || '',
    senderEmail: company.glsSenderEmail || '',
  };
}

function isConfigured(company) {
  const c = cfg(company);
  return Boolean(
    c.username && c.password && c.clientNumber &&
    c.senderName && c.senderAddress && c.senderCity && c.senderZipcode
  );
}

const COUNTRY_DOMAINS = {
  RO: 'mygls.ro', HU: 'mygls.hu', CZ: 'mygls.cz', SK: 'mygls.sk',
  HR: 'mygls.hr', SI: 'mygls.si', RS: 'mygls.rs',
};

function getBaseUrl(company) {
  if (process.env.GLS_BASE_URL) return process.env.GLS_BASE_URL;
  const c = cfg(company);
  const domain = COUNTRY_DOMAINS[c.countryCode] || COUNTRY_DOMAINS.RO;
  const sub = c.environment === 'test' ? 'api.test' : 'api';
  return `https://${sub}.${domain}`;
}

function authBase(company) {
  const c = cfg(company);
  const hash = crypto.createHash('sha512').update(c.password, 'utf-8').digest();
  return {
    Username: c.username,
    Password: Array.from(hash),
  };
}

function toGlsDate(date) {
  return `/Date(${date.getTime()})/`;
}

async function callParcelService(company, method, body) {
  if (!isConfigured(company)) {
    throw new Error('Integrarea GLS nu este configurată pentru această companie (completați datele în Setări).');
  }
  const url = `${getBaseUrl(company)}/ParcelService.svc/json/${method}`;
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

async function findByClientReference(company, clientReference, daysBack = 30) {
  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const body = {
    ...authBase(company),
    PickupDateFrom: toGlsDate(from),
    PickupDateTo: toGlsDate(now),
    PrintDateFrom: toGlsDate(from),
    PrintDateTo: toGlsDate(now),
  };
  const data = await callParcelService(company, 'GetParcelList', body);
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

async function _printLabel(company, parcelFields) {
  const c = cfg(company);
  const body = {
    ...authBase(company),
    WebshopEngine: c.webshopEngine,
    ParcelList: [parcelFields],
    PrintPosition: 1,
    ShowPrintDialog: false,
    TypeOfPrinter: c.typeOfPrinter,
  };
  const data = await callParcelService(company, 'PrintLabels', body);
  if (data.PrintLabelsErrorList && data.PrintLabelsErrorList.length) {
    const err = data.PrintLabelsErrorList[0];
    if (Number(err.ErrorCode) === 18) {
      let existing;
      try {
        existing = await findByClientReference(company, parcelFields.ClientReference);
      } catch (diagErr) {
        throw new Error(`GLS spune că eticheta e deja generată, dar recuperarea automată a eșuat: ${diagErr.message}`);
      }
      if (existing) {
        return {
          trackingNumber: String(existing.ParcelNumber),
          parcelId: existing.ParcelId,
          labelPdf: null,
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

async function createParcel(company, order) {
  const c = cfg(company);
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
  return _printLabel(company, parcel);
}

async function createPickupAwb(company, pickup) {
  const c = cfg(company);
  const serviceCode = pickup.reason === 'retur' ? 'PRS' : 'PSS';
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
  return _printLabel(company, parcel);
}

async function deleteParcel(company, parcelId) {
  const body = {
    ...authBase(company),
    ParcelIdList: [Number(parcelId)],
  };
  const data = await callParcelService(company, 'DeleteLabels', body);
  if (data.DeleteLabelsErrorList && data.DeleteLabelsErrorList.length) {
    const err = data.DeleteLabelsErrorList[0];
    throw new Error(`GLS a refuzat anularea (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }
  return { success: true };
}

async function getParcelStatus(company, trackingNumber) {
  const body = {
    ...authBase(company),
    ParcelNumber: Number(trackingNumber),
    ReturnPOD: false,
    LanguageIsoCode: 'RO',
  };
  const data = await callParcelService(company, 'GetParcelStatuses', body);
  if (data.GetParcelStatusErrors && data.GetParcelStatusErrors.length) {
    const err = data.GetParcelStatusErrors[0];
    throw new Error(`GLS a refuzat cererea (cod ${err.ErrorCode}): ${err.ErrorDescription}`);
  }
  return data.ParcelStatusList || [];
}

async function getLabelPdf(company, parcelId) {
  const body = {
    ...authBase(company),
    ParcelIdList: [Number(parcelId)],
    PrintPosition: 1,
    ShowPrintDialog: false,
    TypeOfPrinter: cfg(company).typeOfPrinter,
  };
  const data = await callParcelService(company, 'GetPrintedLabels', body);
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
