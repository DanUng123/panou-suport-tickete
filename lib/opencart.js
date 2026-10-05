// Client pentru magazinele OpenCart.
//
// DE CE ALTFEL DECAT LA MERCHANTPRO SI GOMAG: OpenCart nu are un API prin care
// sa poti citi comenzile. API-ul lui intern e facut pentru cos si pentru
// plasarea unei comenzi, iar in OpenCart 4 pana si ce mergea in 3 s-a stricat
// -- chiar dezvoltatorii OpenCart spun ca nu e un API REST si recomanda o
// extensie proprie. Asa ca magazinul primeste de la noi un fisier PHP
// (conector-opencart/easyticket.php) pe care il pune la el, iar noi vorbim cu
// el. Avantajul: raspunsul vine exact in forma de care avem nevoie, deci nu se
// mai repeta povestea cu codul postal lipsa de la GoMag.
//
// MULTI-COMPANIE: fiecare functie primeste `company` (obiectul intors de
// db.getCompany(), cu credentialele decriptate) ca prim argument.

const TIMP_MAXIM_MS = Number(process.env.OPENCART_TIMEOUT_MS || 25000);

function isConfigured(company) {
  return Boolean(company.opencartConnectorUrl && company.opencartApiKey && company.opencartActive !== false);
}

/** Adresa conectorului, curatata de spatii si de un eventual `?` lasat la coada. */
function adresaConector(company) {
  return String(company.opencartConnectorUrl || '').trim().replace(/[?&]+$/, '');
}

async function request(company, actiune, params = {}) {
  if (!isConfigured(company)) {
    throw new Error('Integrarea OpenCart nu este configurată pentru această companie (completați datele în Setări).');
  }
  const baza = adresaConector(company);
  let url;
  try {
    url = new URL(baza);
  } catch (e) {
    throw new Error(`Adresa conectorului nu este validă: „${baza}”. Trebuie să fie adresa completă a fișierului, de forma https://magazinul-tau.ro/easyticket.php`);
  }
  url.searchParams.set('action', actiune);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  // Oprirea dupa un timp e obligatorie: conectorul sta pe serverul clientului,
  // iar o gazduire incarcata poate tine conexiunea deschisa la nesfarsit. Fara
  // limita, un singur magazin lent ar bloca sincronizarea tuturor celorlalte.
  const ceas = AbortSignal.timeout(TIMP_MAXIM_MS);
  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      // Cheia merge prin antet. Conectorul accepta si parametrul `key`, pentru
      // gazduirile care taie anteturile necunoscute, dar acolo ar ajunge in
      // jurnalele serverului web -- deci il folosim doar ca ultima solutie.
      headers: {
        'X-EasyTicket-Key': company.opencartApiKey,
        'Accept': 'application/json',
        'User-Agent': 'Easy-Ticket-Integration/1.0',
      },
      signal: ceas,
            redirect: 'follow',
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`Magazinul nu a răspuns în ${Math.round(TIMP_MAXIM_MS / 1000)} secunde. Verifică dacă adresa conectorului e corectă și dacă serverul magazinului funcționează.`);
    }
    throw new Error(`Nu am putut contacta conectorul la ${baza}: ${e.message}`);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* vedem mai jos */ }

  // Codul HTTP se verifica INAINTE de a ne plange ca raspunsul nu e JSON:
  // la un 404, serverul magazinului trimite propria pagina de eroare, iar
  // „adresa nu exista" e un mesaj mult mai util decat „raspuns neinteligibil".
  if (res.status === 404) {
    throw new Error(`Adresa ${baza} nu există pe serverul magazinului (404). Verifică unde ai urcat fișierul easyticket.php.`);
  }
  if (res.status === 403) {
    throw new Error(`Serverul magazinului a refuzat accesul la ${baza} (403). De obicei înseamnă că găzduirea blochează fișierul — cere-i furnizorului să permită accesul la el.`);
  }

  if (!data) {
    // Cel mai frecvent caz real: adresa duce la o pagina obisnuita din magazin
    // (sau la pagina de eroare a gazduirii), nu la conector. Spunem exact asta,
    // nu „raspuns invalid".
    const inceput = (text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (/^\s*</.test(text || '')) {
      throw new Error(`Adresa ${baza} a răspuns cu o pagină web, nu cu datele conectorului. Verifică dacă ai urcat fișierul easyticket.php și dacă adresa duce chiar la el.`);
    }
    throw new Error(`Răspuns neinteligibil de la ${baza} (HTTP ${res.status})${inceput ? `: ${inceput}` : ''}`);
  }

  if (!res.ok || data.ok === false) {
    const motiv = data.error || `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new Error(`Cheia a fost respinsă de magazin. Descarcă din nou conectorul din Setări și înlocuiește fișierul de pe server — cheia e scrisă chiar în el.`);
    }
    if (res.status === 404) {
      throw new Error(`Adresa ${baza} nu există pe serverul magazinului (404). Verifică unde ai urcat fișierul easyticket.php.`);
    }
    throw new Error(`Conectorul OpenCart a răspuns cu o eroare: ${motiv}`);
  }

  return data;
}

/** Verificarea conexiunii: versiune OpenCart, câte comenzi are magazinul, ultima comandă. */
async function ping(company) {
  const d = await request(company, 'ping');
  return {
    connectorVersion: d.connector_version || null,
    opencartVersion: d.opencart || null,
    php: d.php || null,
    storeUrl: d.store_url || null,
    schema: d.schema || null,
    ordersTotal: Number(d.orders_total) || 0,
    lastOrderAt: d.last_order_at || null,
  };
}

/** O pagină de comenzi. `since` filtrează după data ultimei modificări. */
async function listOrders(company, { page = 1, limit = 100, since = '', ids = '' } = {}) {
  const d = await request(company, 'orders', { page, limit, since, ids });
  return {
    items: Array.isArray(d.orders) ? d.orders : [],
    total: Number(d.total) || 0,
    page: Number(d.page) || page,
    pages: Number(d.pages) || 1,
  };
}

// Plafon de siguranta: la prima sincronizare a unui magazin cu ani de istoric,
// fara el am cere la nesfarsit pagina urmatoare. Ce nu intra acum intra la
// ciclul urmator, pentru ca sincronizarea merge in ordinea modificarii.
const MAX_PAGINI = Number(process.env.OPENCART_MAX_PAGES || 200);

/** Toate comenzile care se potrivesc filtrului, paginând automat. */
async function listAllOrders(company, { since = '', limit = 100 } = {}) {
  let page = 1;
  let toate = [];
  while (page <= MAX_PAGINI) {
    const rezultat = await listOrders(company, { page, limit, since });
    toate = toate.concat(rezultat.items);
    if (page >= rezultat.pages || !rezultat.items.length) break;
    page += 1;
  }
  return toate;
}

module.exports = {
  isConfigured,
  adresaConector,
  ping,
  listOrders,
  listAllOrders,
};
