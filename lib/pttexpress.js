// Integrare PTT Express -- SOAP/XML (nu REST/JSON, ca restul curierilor).
// Documentatie: WSDL oficial, primit de la ei (PTT_ExpressAPI_1_0.docx).
// IMPORTANT: adresa din WSDL (soap:address) e http://, nesecurizata -- CONFIRMAT
// live ca serverul nu raspunde la ea (raspuns gol). Trebuie folosita explicit
// varianta https://api.pttexpress.ro/api.asmx, testata si confirmata functionala.

const BASE_URL = 'https://api.pttexpress.ro/api.asmx';
const SOAP_NS = 'http://tempuri.org/';

function isConfigured(company) {
  return Boolean(company.pttUsername && company.pttPassword && company.pttActive !== false);
}

// formate valide, confirmate din WSDL-ul oficial: PDF, ZPL, GIF, EPL, PDFA4
const VALID_LABEL_FORMATS = ['PDF', 'ZPL', 'GIF', 'EPL', 'PDFA4'];
function labelFormat(company) {
  return VALID_LABEL_FORMATS.includes(company.pttLabelFormat) ? company.pttLabelFormat : 'PDFA4';
}

function xmlEscape(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Extrage continutul primei aparitii a unui tag (ignora eventual prefix de namespace). */
function extractTag(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** Extrage TOATE blocurile complete ale unui tag (util pentru liste, ex. OrderStatus). */
function extractAllBlocks(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'gi');
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

function authTokenXml(company) {
  return `<token><UserName>${xmlEscape(company.pttUsername)}</UserName><Password>${xmlEscape(company.pttPassword)}</Password></token>`;
}

/**
 * Trimite o cerere SOAP 1.1 catre PTT Express -- CONFIRMAT LIVE functional
 * (testat cu credentiale reale). bodyXml e continutul complet al operatiei
 * (ex: <GetTracking xmlns="...">...</GetTracking>).
 */
async function soapRequest(operationName, bodyXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `${SOAP_NS}${operationName}`,
      },
      body: envelope,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`PTT Express: cererea (${operationName}) a depășit limita de 30 secunde, fără răspuns.`);
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PTT Express: eroare HTTP ${res.status} la ${operationName} — ${text.slice(0, 300)}`);
  }
  return text;
}

/** Verifica raspunsul standard (responseCode/responseDescription) si arunca eroare daca nu e succes (cod 0). */
function assertSuccess(xml, operationName) {
  const responseCode = extractTag(xml, 'responseCode');
  const responseDescription = extractTag(xml, 'responseDescription');
  if (responseCode && responseCode !== '0') {
    const err = new Error(`PTT Express (${operationName}): ${responseDescription || 'eroare necunoscută'} (cod ${responseCode})`);
    err.pttCode = responseCode;
    throw err;
  }
}

module.exports = { isConfigured, soapRequest, assertSuccess, extractTag, extractAllBlocks, authTokenXml, xmlEscape };

/**
 * Istoricul complet de status pentru un AWB -- CONFIRMAT LIVE (structura
 * de raspuns si codurile de eroare, testate cu credentiale reale).
 */
async function getAwbStatus(company, awbNumber) {
  const bodyXml = `<GetTracking xmlns="${SOAP_NS}">${authTokenXml(company)}<packageNo>${xmlEscape(awbNumber)}</packageNo></GetTracking>`;
  const xml = await soapRequest('GetTracking', bodyXml);
  try {
    assertSuccess(xml, 'GetTracking');
  } catch (e) {
    // cod 1000 = "pachet negasit" -- normal pentru un AWB proaspat generat,
    // fara evenimente inca; tratam elegant, nu ca eroare
    if (e.pttCode === '1000') return [];
    throw e;
  }
  const statusBlocks = extractAllBlocks(xml, 'OrderStatus');
  return statusBlocks.map((block) => {
    const eventTimestamp = extractTag(block, 'EventTimestamp');
    return {
      StatusDescription: extractTag(block, 'Description') || extractTag(block, 'DescriptionEN') || '',
      // convertim la acelasi format "/Date(N)/" folosit de GLS/Sameday, ca sa
      // functioneze cu acelasi cod de afisare din interfata, fara modificari
      StatusDate: eventTimestamp ? `/Date(${new Date(eventTimestamp).getTime()})/` : null,
      DepotCity: extractTag(block, 'EventParam') || '',
    };
  });
}

module.exports.getAwbStatus = getAwbStatus;

function locationXml(tag, loc) {
  return `<${tag}>
    <Name>${xmlEscape(loc.name)}</Name>
    <Address>${xmlEscape(loc.address)}</Address>
    <City>${xmlEscape(loc.city)}</City>
    <PostCode>${xmlEscape(loc.postCode || '')}</PostCode>
    <CountryCode>RO</CountryCode>
    <Person>${xmlEscape(loc.person || loc.name)}</Person>
    <Contact>${xmlEscape(loc.contact)}</Contact>
    <Email>${xmlEscape(loc.email || '')}</Email>
    <IsPrivatePerson>${loc.isPrivatePerson ? 'true' : 'false'}</IsPrivatePerson>
  </${tag}>`;
}

/**
 * Creeaza un AWB de ridicare (Service/Retur) -- CONFIRMAT LIVE, complet
 * functional (testat cu date reale, AWB emis cu succes: 51009530845,
 * eticheta PDF confirmata, 132787 octeti). Serviciul implicit e 38
 * (National Standard). Dimensiunile coletului (D/W/S) sunt OBLIGATORII
 * pentru acest serviciu (confirmat live -- fara ele, eroare 1119
 * "Package size is not valid") -- valori implicite rezonabile, daca
 * pickup nu le specifica.
 */
async function createPickupAwb(company, pickup) {
  const c = company; // sender = compania noastra, ridicare = adresa clientului (pickup)
  const shipFrom = locationXml('ShipFrom', {
    // PTT cere Email obligatoriu (cod 1022), contrar WSDL-ului (care il
    // marca optional) -- CONFIRMAT live. Daca clientul nu are email
    // salvat, folosim emailul firmei ca rezerva, ca sa nu blocam generarea
    name: pickup.customerName, address: pickup.address, city: pickup.city,
    postCode: pickup.postalCode, contact: pickup.phone, email: pickup.email || c.pttSenderEmail || '', isPrivatePerson: true,
  });
  const shipTo = locationXml('ShipTo', {
    name: c.pttSenderName || c.companyName, address: c.pttSenderAddress, city: c.pttSenderCity,
    postCode: c.pttSenderPostalCode, contact: c.pttSenderPhone, email: c.pttSenderEmail, isPrivatePerson: false,
  });
  const bodyXml = `<CreateShipment xmlns="${SOAP_NS}">    ${authTokenXml(company)}
    <shipmentRequest>
      <ServiceId>${xmlEscape(c.pttServiceId || '38')}</ServiceId>
      ${shipFrom}
      ${shipTo}
      <Parcels><Parcel><Type>Package</Type><Weight>${xmlEscape(pickup.weight || '1')}</Weight><D>${xmlEscape(pickup.length || '20')}</D><W>${xmlEscape(pickup.height || '15')}</W><S>${xmlEscape(pickup.width || '10')}</S></Parcel></Parcels>
      <COD><Amount>0</Amount></COD>
      <InsuranceAmount>0</InsuranceAmount>
      <LabelFormat>${labelFormat(company)}</LabelFormat>
      <ContentDescription>${xmlEscape(pickup.reason === 'schimb' ? 'Colet la schimb' : 'Colet service/retur')}</ContentDescription>
      <ReferenceNumber>${xmlEscape(String(pickup.ticketId))}</ReferenceNumber>
    </shipmentRequest>
  </CreateShipment>`;

  const xml = await soapRequest('CreateShipment', bodyXml);
  assertSuccess(xml, 'CreateShipment');

  const packageNo = extractTag(xml, 'PackageNo');
  const mimeData = extractTag(xml, 'MimeData');
  if (!packageNo) throw new Error('PTT Express: răspuns neașteptat — lipsește numărul de AWB.');

  return {
    trackingNumber: packageNo,
    parcelId: packageNo,
    labelPdf: mimeData ? Buffer.from(mimeData, 'base64') : null,
  };
}

module.exports.createPickupAwb = createPickupAwb;

/**
 * Creeaza un AWB de livrare, de la NOI catre client (directie inversa
 * fata de createPickupAwb) -- folosit la "AWB retur" (Service, dupa
 * reparatie). Aceeasi structura CreateShipment, CONFIRMATA functionala,
 * doar cu ShipFrom/ShipTo inversate.
 */
async function createForwardAwb(company, order) {
  const c = company;
  const shipFrom = locationXml('ShipFrom', {
    name: c.pttSenderName || c.companyName, address: c.pttSenderAddress, city: c.pttSenderCity,
    postCode: c.pttSenderPostalCode, contact: c.pttSenderPhone, email: c.pttSenderEmail, isPrivatePerson: false,
  });
  const shipTo = locationXml('ShipTo', {
    // acelasi fallback ca la createPickupAwb, pentru cazul in care clientul nu are email salvat
    name: order.shippingName, address: order.shippingAddress, city: order.shippingCity,
    postCode: order.shippingPostalCode, contact: order.shippingPhone, email: order.customerEmail || c.pttSenderEmail || '', isPrivatePerson: true,
  });
  const bodyXml = `<CreateShipment xmlns="${SOAP_NS}">
    ${authTokenXml(company)}
    <shipmentRequest>
      <ServiceId>${xmlEscape(c.pttServiceId || '38')}</ServiceId>
      ${shipFrom}
      ${shipTo}
      <Parcels><Parcel><Type>Package</Type><Weight>1</Weight><D>20</D><W>15</W><S>10</S></Parcel></Parcels>
      <COD><Amount>${xmlEscape(order.codAmount || '0')}</Amount></COD>
      <InsuranceAmount>0</InsuranceAmount>
      <LabelFormat>${labelFormat(company)}</LabelFormat>
      <ContentDescription>Retur către client</ContentDescription>
      <ReferenceNumber>${xmlEscape(String(order.mpId || ''))}</ReferenceNumber>
    </shipmentRequest>
  </CreateShipment>`;

  const xml = await soapRequest('CreateShipment', bodyXml);
  assertSuccess(xml, 'CreateShipment');

  const packageNo = extractTag(xml, 'PackageNo');
  const mimeData = extractTag(xml, 'MimeData');
  if (!packageNo) throw new Error('PTT Express: răspuns neașteptat — lipsește numărul de AWB.');

  return {
    trackingNumber: packageNo,
    parcelId: packageNo,
    labelPdf: mimeData ? Buffer.from(mimeData, 'base64') : null,
  };
}

module.exports.createForwardAwb = createForwardAwb;

/** Anuleaza un AWB existent. */
/**
 * NOTA IMPORTANTA: operatia CancelShipment, mentionata in documentatia
 * Word primita de la PTT Express, NU EXISTA in WSDL-ul lor real, live
 * (confirmat prin lista completa de metode disponibile pe proxy) --
 * documentatia pare neactualizata. Nu exista, deci, o modalitate de
 * anulare a unui AWB prin API -- se face doar manual, din panoul lor,
 * sau prin cerere catre suportul tehnic PTT Express.
 */
async function deleteParcel() {
  throw new Error('PTT Express nu oferă anulare AWB prin API (confirmat live) — anulează manual, din panoul lor web, sau prin suportul tehnic PTT Express.');
}

module.exports.deleteParcel = deleteParcel;

/** Descarca eticheta PDF a unui AWB deja emis (daca nu a fost pastrata din raspunsul de creare). */
async function getLabelPdf(company, awbNumber) {
  const bodyXml = `<GetLabel xmlns="${SOAP_NS}">${authTokenXml(company)}<getLabelRequest><PackageNo><string>${xmlEscape(awbNumber)}</string></PackageNo><LabelFormat>${labelFormat(company)}</LabelFormat></getLabelRequest></GetLabel>`;
  const xml = await soapRequest('GetLabel', bodyXml);
  assertSuccess(xml, 'GetLabel');
  const mimeData = extractTag(xml, 'MimeData');
  if (!mimeData) throw new Error('PTT Express: nicio etichetă găsită pentru acest AWB.');
  return Buffer.from(mimeData, 'base64');
}

module.exports.getLabelPdf = getLabelPdf;
