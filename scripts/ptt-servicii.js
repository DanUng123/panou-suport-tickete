// Diagnostic de unica folosinta -- NU face parte din aplicatie.
// Intreaba PTT Express ce servicii sunt disponibile pe contul tau, ca sa vedem
// daca exista un serviciu de tip "colet la schimb" (echivalentul SWAP de la
// Sameday sau Exchange/XS de la GLS).
//
// Rulare (din radacina proiectului):
//   node scripts/ptt-servicii.js UTILIZATOR PAROLA
//
// Optional, cu un AWB existent, ca sa testam si eticheta de retur:
//   node scripts/ptt-servicii.js UTILIZATOR PAROLA 51009530845
//
// Dupa ce ne lamurim, fisierul poate fi sters.

const BASE_URL = 'https://api.pttexpress.ro/api.asmx';
const SOAP_NS = 'http://tempuri.org/';

const [userName, password, awbNumber] = process.argv.slice(2);
if (!userName || !password) {
  console.error('Lipsesc credentialele. Foloseste: node scripts/ptt-servicii.js UTILIZATOR PAROLA [AWB]');
  process.exit(1);
}

function xmlEscape(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function soapRequest(operationName, bodyXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `${SOAP_NS}${operationName}` },
    body: envelope,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 500)}`);
  return text;
}

function extractAllBlocks(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'gi');
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

function extractTag(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

const token = `<token><UserName>${xmlEscape(userName)}</UserName><Password>${xmlEscape(password)}</Password></token>`;

// ruta de test: Bucuresti -> Cluj-Napoca, colet standard de 1 kg
function location(tag, loc) {
  return `<${tag}>
      <Name>${xmlEscape(loc.name)}</Name>
      <Address>${xmlEscape(loc.address)}</Address>
      <City>${xmlEscape(loc.city)}</City>
      <PostCode>${xmlEscape(loc.postCode)}</PostCode>
      <CountryCode>RO</CountryCode>
      <Person>${xmlEscape(loc.name)}</Person>
      <Contact>0700000000</Contact>
      <Email>test@example.com</Email>
      <IsPrivatePerson>${loc.isPrivatePerson ? 'true' : 'false'}</IsPrivatePerson>
    </${tag}>`;
}

async function listServices() {
  const readyDate = new Date().toISOString().slice(0, 19);
  const bodyXml = `<GetAvailableServices xmlns="${SOAP_NS}">${token}
    <getAvailableServicesRequest>
      <ReadyDate>${readyDate}</ReadyDate>
      ${location('ShipFrom', { name: 'Expeditor Test', address: 'Strada Test 1', city: 'Bucuresti', postCode: '010101', isPrivatePerson: false })}
      ${location('ShipTo', { name: 'Destinatar Test', address: 'Strada Test 2', city: 'Cluj-Napoca', postCode: '400001', isPrivatePerson: true })}
      <Parcels><Parcel><Type>Package</Type><Weight>1</Weight><D>20</D><W>15</W><S>10</S></Parcel></Parcels>
      <COD><Amount>0</Amount></COD>
      <InsuranceAmount>0</InsuranceAmount>
    </getAvailableServicesRequest>
  </GetAvailableServices>`;

  const xml = await soapRequest('GetAvailableServices', bodyXml);
  const code = extractTag(xml, 'responseCode');
  if (code && code !== '0') {
    console.log(`Raspuns cu eroare (cod ${code}): ${extractTag(xml, 'responseDescription') || '—'}`);
    console.log('\nXML brut:\n', xml.slice(0, 3000));
    return;
  }
  const services = extractAllBlocks(xml, 'Service');
  if (!services.length) {
    console.log('Niciun serviciu returnat. XML brut:\n', xml.slice(0, 3000));
    return;
  }
  console.log(`Servicii disponibile pe contul tau (${services.length}):\n`);
  for (const s of services) {
    console.log(`  ID ${extractTag(s, 'ID')}\t${extractTag(s, 'Name')}\t${extractTag(s, 'Price') || '—'}`);
  }
  console.log('\nCautam ceva de tipul: schimb / swap / exchange / retur simultan.');
}

async function testReturnLabel(awb) {
  const bodyXml = `<GetReturnLabel xmlns="${SOAP_NS}">${token}
    <getReturnLabelRequest>
      <PackageNo><string>${xmlEscape(awb)}</string></PackageNo>
      <ConsolidateLabels>false</ConsolidateLabels>
      <Format>PDFA4</Format>
    </getReturnLabelRequest>
  </GetReturnLabel>`;
  const xml = await soapRequest('GetReturnLabel', bodyXml);
  const code = extractTag(xml, 'responseCode');
  const mimeData = extractTag(xml, 'MimeData');
  console.log(`\nGetReturnLabel pentru ${awb}: cod ${code ?? '—'}, descriere: ${extractTag(xml, 'responseDescription') || '—'}`);
  console.log(mimeData
    ? `  → eticheta de retur PRIMITA (${Math.round(mimeData.length * 0.75)} octeti) — deci se poate emite un AWB de retur pe un colet existent.`
    : '  → nicio eticheta returnata.');
}

(async () => {
  try {
    await listServices();
    if (awbNumber) await testReturnLabel(awbNumber);
  } catch (e) {
    console.error('Eroare:', e.message);
    process.exit(1);
  }
})();
