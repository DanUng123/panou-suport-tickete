// Client pentru API-ul GLS (sistemul folosit de GLS Romania, Ungaria, Cehia,
// Slovacia -- acelasi backend "online.gls-<tara>" cu WSDL/SOAP).
//
// IMPORTANT -- limitari cunoscute:
// Acest client a fost construit pe baza structurii documentate intr-o
// implementare open-source dovedita functionala pentru acelasi sistem
// (biblioteca "gls-cee-shipping-api"), NU pe baza testarii directe
// impotriva serverului real GLS -- mediul in care a fost scris acest cod
// nu are acces la internet. Testeaza cu atentie prima cerere reala.
//
// Necesita variabile de mediu:
//   GLS_USERNAME, GLS_PASSWORD, GLS_CLIENT_NUMBER  -- credentialele primite de la GLS
//   GLS_SENDER_NAME, GLS_SENDER_ADDRESS, GLS_SENDER_CITY, GLS_SENDER_ZIPCODE,
//   GLS_SENDER_CONTACT, GLS_SENDER_PHONE, GLS_SENDER_EMAIL -- datele firmei tale (expeditor)
//   GLS_SENDER_COUNTRY  -- optional, implicit "RO"
//   GLS_COUNTRY_CODE    -- optional, implicit "RO"

const zlib = require('zlib');

function cfg() {
  return {
    username: process.env.GLS_USERNAME || '',
    password: process.env.GLS_PASSWORD || '',
    clientNumber: process.env.GLS_CLIENT_NUMBER || '',
    countryCode: (process.env.GLS_COUNTRY_CODE || 'RO').toUpperCase(),
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
  return Boolean(c.username && c.password && c.clientNumber && c.senderName && c.senderAddress && c.senderCity && c.senderZipcode);
}

const WSDL_URLS = {
  RO: 'http://online.gls-romania.ro/webservices/soap_server.php?wsdl&ver=18.09.12.01',
  HU: 'https://online.gls-hungary.com/webservices/soap_server.php?wsdl&ver=18.09.12.01',
  CZ: 'http://online.gls-czech.com/webservices/soap_server.php?wsdl&ver=18.09.12.01',
  SK: 'http://online.gls-slovakia.sk/webservices/soap_server.php?wsdl&ver=18.09.12.01',
};

function getWsdlUrl() {
  if (process.env.GLS_WSDL_URL) return process.env.GLS_WSDL_URL;
  return WSDL_URLS[cfg().countryCode] || WSDL_URLS.RO;
}

// ---------- auto-descoperire endpoint SOAP + namespace, din WSDL-ul publicat ----------
// Evitam sa "ghicim" adresa/namespace-ul -- le citim direct din WSDL la prima
// cerere si le tinem in cache.

let discovered = null;

async function discoverServiceInfo() {
  if (discovered) return discovered;
  const wsdlUrl = getWsdlUrl();
  const res = await fetch(wsdlUrl);
  if (!res.ok) throw new Error(`Nu am putut accesa WSDL-ul GLS (${res.status})`);
  const xml = await res.text();

  const addrMatch = xml.match(/address[^>]*location="([^"]+)"/i);
  const nsMatch = xml.match(/targetNamespace="([^"]+)"/i);

  discovered = {
    endpoint: addrMatch ? addrMatch[1] : wsdlUrl.split('?')[0],
    namespace: nsMatch ? nsMatch[1] : 'urn:soap_server',
  };
  return discovered;
}

// ---------- construire XML "DTU" (formatul de date GLS pentru colete) ----------

function escapeXml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function isoNow() {
  return new Date().toISOString();
}

/**
 * Construieste XML-ul DTU pentru un singur colet (metoda prepareLabels).
 * parcel: { clientRef, codAmount, codCurrency, codRef, pcount, info,
 *           consigName, consigAddress, consigZipcode, consigCity, consigCountry,
 *           consigContact, consigPhone, consigEmail }
 */
function buildPrepareLabelsXml(parcel, c) {
  const codService = parcel.codAmount > 0 ? `
      <Services>
        <Service Code="COD">
          <Info>
            <ServiceInfo InfoType="INFO" InfoData="${escapeXml(parcel.codAmount)}" />
          </Info>
        </Service>
      </Services>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<DTU EmailAddress="${escapeXml(c.senderEmail)}" Version="18.09.12.01" Created="${isoNow()}" RequestType="GlsApiRequest" MethodName="prepareLabels">
  <Shipments>
    <Shipment SenderID="${escapeXml(c.clientNumber)}" ExpSenderID="" PickupDate="${isoNow()}" ClientRef="${escapeXml(parcel.clientRef)}" CODAmount="${escapeXml(parcel.codAmount || 0)}" CODCurr="${escapeXml(parcel.codCurrency || 'RON')}" CODRef="${escapeXml(parcel.codRef || parcel.clientRef)}" PCount="${escapeXml(parcel.pcount || 1)}" Info="${escapeXml(parcel.info || '')}">
      <From Name="${escapeXml(c.senderName)}" Address="${escapeXml(c.senderAddress)}" ZipCode="${escapeXml(c.senderZipcode)}" City="${escapeXml(c.senderCity)}" CtrCode="${escapeXml(c.senderCountry)}" ContactName="${escapeXml(c.senderContact)}" ContactPhone="${escapeXml(c.senderPhone)}" EmailAddress="${escapeXml(c.senderEmail)}" />
      <To Name="${escapeXml(parcel.consigName)}" Address="${escapeXml(parcel.consigAddress)}" ZipCode="${escapeXml(parcel.consigZipcode)}" City="${escapeXml(parcel.consigCity)}" CtrCode="${escapeXml(parcel.consigCountry || 'RO')}" ContactName="${escapeXml(parcel.consigContact || parcel.consigName)}" ContactPhone="${escapeXml(parcel.consigPhone)}" EmailAddress="${escapeXml(parcel.consigEmail || '')}" />${codService}
    </Shipment>
  </Shipments>
</DTU>`;
}

// ---------- apel SOAP ----------

async function soapCall(method, namedParams) {
  const c = cfg();
  if (!isConfigured()) throw new Error('Integrarea GLS nu este configurată (variabile de mediu lipsă).');

  const { endpoint, namespace } = await discoverServiceInfo();

  const paramsXml = Object.entries(namedParams)
    .map(([key, value]) => `<${key} xsi:type="xsd:string">${escapeXml(value)}</${key}>`)
    .join('\n      ');

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <${method} xmlns="${namespace}">
      ${paramsXml}
    </${method}>
  </soap:Body>
</soap:Envelope>`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': `"${namespace}#${method}"`,
    },
    body: envelope,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Eroare HTTP de la GLS (${res.status}): ${text.slice(0, 300)}`);
  }

  const faultMatch = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (faultMatch) {
    throw new Error(`Eroare SOAP de la GLS: ${faultMatch[1]}`);
  }

  const returnMatch = text.match(/<return[^>]*>([\s\S]*?)<\/return>/i);
  if (!returnMatch) {
    throw new Error('Răspuns neașteptat de la GLS (nu am găsit elementul <return>).');
  }

  return returnMatch[1].trim();
}

function decodeGzippedBase64(str) {
  return zlib.gunzipSync(Buffer.from(str, 'base64')).toString('utf-8');
}

// ---------- operatii publice ----------

/**
 * Creeaza un colet (AWB) la GLS.
 * order: obiect cu datele comenzii (vezi apelul din server.js pentru campuri).
 * Intoarce { trackingCode } sau arunca eroare cu mesajul primit de la GLS.
 */
async function createParcel(order) {
  const c = cfg();
  const parcel = {
    clientRef: String(order.mpId),
    codAmount: order.codAmount || 0,
    codCurrency: order.currency || 'RON',
    codRef: String(order.mpId),
    pcount: 1,
    info: `Comanda #${order.mpId}`,
    consigName: order.shippingName,
    consigAddress: order.shippingAddress,
    consigZipcode: order.shippingPostalCode,
    consigCity: order.shippingCity,
    consigCountry: 'RO',
    consigContact: order.shippingName,
    consigPhone: order.shippingPhone,
    consigEmail: order.customerEmail,
  };

  const dtuXml = buildPrepareLabelsXml(parcel, c);
  const gzB64 = zlib.gzipSync(Buffer.from(dtuXml, 'utf-8')).toString('base64');

  const returnValue = await soapCall('preparelabels_gzipped_xml', {
    username: c.username,
    password: c.password,
    senderid: c.clientNumber,
    data: gzB64,
  });

  const responseXml = decodeGzippedBase64(returnValue);

  const statusMatch = responseXml.match(/<Status[^>]*>([\s\S]*?)<\/Status>/i) || responseXml.match(/<Status([^>]*)\/>/i);
  const errorDescMatch = responseXml.match(/ErrorDescription="([^"]*)"/i);
  const trackingMatch = responseXml.match(/<long>(\d+)<\/long>/i);

  if (errorDescMatch && errorDescMatch[1]) {
    throw new Error(`GLS a refuzat cererea: ${errorDescMatch[1]}`);
  }
  if (!trackingMatch) {
    throw new Error(`Nu am putut extrage numărul AWB din răspunsul GLS. Răspuns brut: ${responseXml.slice(0, 500)}`);
  }

  return { trackingCode: trackingMatch[1], rawResponse: responseXml };
}

/** Anuleaza (sterge) un colet deja creat la GLS, pe baza numarului AWB/PclID. */
async function deleteParcel(trackingCode) {
  const c = cfg();
  const dtuXml = `<?xml version="1.0" encoding="UTF-8"?>
<DTU EmailAddress="${escapeXml(c.senderEmail)}" Version="18.09.12.01" Created="${isoNow()}" RequestType="GlsApiRequest" MethodName="deleteLabels">
  <Shipments>
    <Shipment><PclIDs><long>${escapeXml(trackingCode)}</long></PclIDs></Shipment>
  </Shipments>
</DTU>`;
  const gzB64 = zlib.gzipSync(Buffer.from(dtuXml, 'utf-8')).toString('base64');

  const returnValue = await soapCall('deletelabels_gzipped_xml', {
    username: c.username,
    password: c.password,
    senderid: c.clientNumber,
    data: gzB64,
  });

  const responseXml = decodeGzippedBase64(returnValue);
  return { rawResponse: responseXml };
}

/** Extrage eticheta PDF (base64) pentru un colet deja creat. */
async function getLabelPdf(trackingCode) {
  const c = cfg();
  const dtuXml = `<?xml version="1.0" encoding="UTF-8"?>
<DTU EmailAddress="${escapeXml(c.senderEmail)}" Version="18.09.12.01" Created="${isoNow()}" RequestType="GlsApiRequest" MethodName="printLabels">
  <Shipments>
    <Shipment><PclIDs><long>${escapeXml(trackingCode)}</long></PclIDs></Shipment>
  </Shipments>
</DTU>`;
  const gzB64 = zlib.gzipSync(Buffer.from(dtuXml, 'utf-8')).toString('base64');

  const returnValue = await soapCall('getprintedlabels_gzipped_xml', {
    username: c.username,
    password: c.password,
    senderid: c.clientNumber,
    data: gzB64,
    printertemplate: 'A6',
  });

  const responseXml = decodeGzippedBase64(returnValue);
  const labelMatch = responseXml.match(/<Label[^>]*>([\s\S]*?)<\/Label>/i);
  if (!labelMatch) {
    throw new Error('Nu am găsit eticheta PDF în răspunsul GLS.');
  }
  return Buffer.from(labelMatch[1].trim(), 'base64');
}

module.exports = { isConfigured, createParcel, deleteParcel, getLabelPdf };
