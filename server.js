// Server HTTP folosind doar module native Node.js (fara npm install necesar).
// Ruleaza cu: node server.js
// Implicit porneste pe portul 3000 (sau process.env.PORT).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const db = require('./lib/db');
const orderSync = require('./lib/order-sync');
const fullHistoryImport = require('./lib/full-history-import');
const samedayTrackingPoller = require('./lib/sameday-tracking-poller');
const gls = require('./lib/gls');
const sameday = require('./lib/sameday');
const pttexpress = require('./lib/pttexpress');
// mapare comuna curier -> modul, folosita peste tot unde citim ticket.pickupAwbCourier/returnAwbCourier
const COURIER_MODULES = { gls, sameday, ptt: pttexpress };
// Curierii prin care se poate emite un colet la schimb. Momentan doar Sameday --
// GLS si PTT Express nu sunt eligibile. Cand se mai adauga unul, se trece aici
// (si in SCHIMB_COURIERS din public/app.js, care controleaza lista din formular).
const SCHIMB_COURIERS = ['sameday'];
// Curierii care nu suporta reemiterea AWB-ului: PTT Express nu expune nicio
// operatie de anulare in API, deci "reemite" ar lasa in urma un AWB fantoma.
const NO_REISSUE_COURIERS = ['ptt'];
const mp = require('./lib/merchantpro');
const gomag = require('./lib/gomag');
const resend = require('./lib/resend');
const pdf = require('./lib/pdf');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- sesiuni simple in memorie (token -> {agentId, expiresAt}) ----------
// Notă: pentru producție la scară mare, folosiți sesiuni persistente / JWT / SSO.
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ore

// ---------- pragul de la care comenzile apar in paginile de lucru ----------
// Ziua se taie la 00:00 ORA ROMANIEI, nu UTC. Vara sunt 3 ore diferenta, deci
// cu taietura in UTC comenzile de azi dintre 00:00 si 03:00 ora Romaniei ar
// ajunge gresit in istoric -- exact orele in care un magazin online chiar
// primeste comenzi.
const FUS_ORAR = 'Europe/Bucharest';

/** Decalajul zonei fata de UTC, in milisecunde, la momentul dat. */
function decalajFusMs(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: FUS_ORAR, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const caUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return caUtc - date.getTime();
}

/** "2026-09-12" (zi calendaristica romaneasca) -> momentul UTC al orei 00:00 din Romania. */
function inceputZiRomaneascaISO(ymd) {
  const presupus = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(presupus.getTime())) return undefined;
  try {
    const d1 = decalajFusMs(presupus);
    let rezultat = new Date(presupus.getTime() - d1);
    // o singura corectie in plus acopera si ziua in care se schimba ora
    const d2 = decalajFusMs(rezultat);
    if (d2 !== d1) rezultat = new Date(presupus.getTime() - d2);
    return rezultat.toISOString();
  } catch (e) {
    // fara date de fus orar in Node (build fara ICU complet), ramanem pe UTC
    return presupus.toISOString();
  }
}

/** Inceputul zilei romanesti in care cade momentul dat. */
function inceputZileiPentru(instant) {
  if (!instant) return undefined;
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return undefined;
  let ymd;
  try {
    ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: FUS_ORAR, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (e) {
    ymd = d.toISOString().slice(0, 10);
  }
  return inceputZiRomaneascaISO(ymd);
}

/** Ziua calendaristica romaneasca ("2026-09-12") in care cade momentul dat. */
function ziRomaneasca(instant) {
  if (!instant) return null;
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: FUS_ORAR, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (e) {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * De la ce moment apar comenzile companiei in paginile de lucru.
 *
 * Intai ordersVisibleFrom -- pus automat cand magazinul si-a conectat prima
 * data platforma de eCommerce, sau ales manual de manager din Setari.
 * Daca lipseste (companii de dinaintea acestei coloane), cadem pe ziua
 * crearii contului, ca inainte.
 */
function pragComenzi(company) {
  if (!company) return undefined;
  if (company.ordersVisibleFrom) return company.ordersVisibleFrom;
  return inceputZileiPentru(company.createdAt);
}

function createSession(agentId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { agentId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getAgentFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const token = match[1];
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(token);
    return null;
  }
  const agent = db.findAgentById(entry.agentId);
  if (!agent) return null;
  // daca intre timp compania a fost dezactivata (din panoul de administrare
  // al platformei), blocam si sesiunile deja active, nu doar login-urile noi
  if (!db.isCompanyActive(agent.companyId)) {
    sessions.delete(token);
    return null;
  }
  return agent;
}

// ---------- sesiuni SEPARATE pentru panoul de administrare al platformei ----------
// Complet distincte de sesiunile agentilor -- cookie diferit, nicio legatura
// cu vreo companie. Autentificare cu o parola unica, din variabila de mediu
// PLATFORM_ADMIN_PASSWORD (setata pe Render, nu stocata in baza de date).
const platformAdminSessions = new Map();
const PLATFORM_ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function createPlatformAdminSession() {
  const token = crypto.randomBytes(24).toString('hex');
  platformAdminSessions.set(token, { expiresAt: Date.now() + PLATFORM_ADMIN_SESSION_TTL_MS });
  return token;
}

function isPlatformAdminRequest(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)platformAdminSession=([^;]+)/);
  if (!match) return false;
  const token = match[1];
  const entry = platformAdminSessions.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    platformAdminSessions.delete(token);
    return false;
  }
  return true;
}

// curatare periodica a sesiunilor de admin expirate
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of platformAdminSessions) {
    if (now > s.expiresAt) platformAdminSessions.delete(token);
  }
}, 60 * 60 * 1000);

// ---------- protectie brute-force la login ----------
// Blocheaza temporar un cont dupa prea multe incercari esuate consecutive.
// Reset simplu, in memorie -- suficient pentru o echipa mica; la scara mare,
// s-ar muta intr-un store persistent (Redis) partajat intre instante.
const loginAttempts = new Map(); // agentId -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minute

function checkLockout(agentId) {
  const entry = loginAttempts.get(agentId);
  if (!entry) return { locked: false };
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const minutesLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return { locked: true, minutesLeft };
  }
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    loginAttempts.delete(agentId); // lockout expirat, resetam
  }
  return { locked: false };
}

function registerFailedAttempt(agentId) {
  const entry = loginAttempts.get(agentId) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  loginAttempts.set(agentId, entry);
}

function clearFailedAttempts(agentId) {
  loginAttempts.delete(agentId);
}

// ---------- limitare generala de rata, pe adresa IP ----------
// Fereastra fixa, simpla, in memorie -- suficienta pentru o instanta unica.
// Curatare periodica, ca sa nu creasca la nesfarsit (vezi mai jos, la finalul fisierului).
const rateLimitBuckets = new Map(); // "scope:ip" -> { count, windowStart }

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** Intoarce true daca cererea trebuie respinsa (prea multe, prea repede). */
function isRateLimited(scope, req, maxRequests, windowMs) {
  const key = `${scope}:${getClientIp(req)}`;
  const now = Date.now();
  const entry = rateLimitBuckets.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    rateLimitBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > maxRequests;
}

// curatare periodica a bucket-urilor vechi, ca Map-ul sa nu creasca la nesfarsit
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitBuckets) {
    if (now - entry.windowStart > 10 * 60 * 1000) rateLimitBuckets.delete(key);
  }
}, 10 * 60 * 1000);

// ---------- utilitare HTTP ----------

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => {
      chunks += c;
      if (chunks.length > maxBytes) {
        reject(new Error('Payload prea mare'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (e) {
        reject(new Error('JSON invalid'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Eticheta primita de la curier nu e mereu PDF: PTT Express o livreaza in
 * formatul ales in Setari -- PDF/PDFA4, dar si GIF sau ZPL/EPL (text pentru
 * imprimante termice). Deducem tipul real din primii octeti si trimitem
 * headerele potrivite; altfel browserul primeste un ".pdf" care nu e PDF si
 * refuza sa-l deschida.
 */
function sendLabelFile(res, buffer, baseName) {
  if (!buffer || buffer.length < 100) {
    return sendJSON(res, 502, { error: `Eticheta primită de la curier e goală sau incompletă (${buffer ? buffer.length : 0} octeți). Regenerează AWB-ul.` });
  }
  const head = buffer.slice(0, 4).toString('latin1');
  let contentType = 'text/plain; charset=utf-8';
  let extension = 'txt';
  let disposition = 'attachment'; // ZPL/EPL: se trimit la imprimanta, nu se citesc pe ecran
  if (head.startsWith('%PDF')) {
    contentType = 'application/pdf';
    extension = 'pdf';
    disposition = 'inline';
  } else if (head.startsWith('GIF8')) {
    contentType = 'image/gif';
    extension = 'gif';
    disposition = 'inline';
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `${disposition}; filename="${baseName}.${extension}"`,
    'Content-Length': buffer.length,
  });
  return res.end(buffer);
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  // previne path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Interzis');
  }

  // o cerere are extensie de fisier (ex: .css, .js) daca ultimul segment al
  // caii contine un punct -- doar rutele FARA extensie (ex: /tickets/abc,
  // generate de rutarea pe hash a front-end-ului) primesc fallback la
  // index.html. Un asset lipsa (css/js gresit) trebuie sa dea 404 real,
  // nu sa fie mascat cu un raspuns 200 continand HTML.
  const lastSegment = pathname.split('/').pop() || '';
  const looksLikeAsset = lastSegment.includes('.');

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (looksLikeAsset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`Fișier negăsit: ${pathname}`);
      }
      // fallback la index.html pentru rutare pe front-end (SPA)
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath);
    // "no-cache" nu inseamna "fara cache", ci "verifica intai daca s-a schimbat":
    // browserul (si Cloudflare) pastreaza fisierul, dar intreaba serverul de
    // fiecare data, iar noi raspundem 304 daca e acelasi. Fara asta, dupa un
    // deploy poti primi in continuare app.js-ul vechi, din cache.
    const etag = `W/"${data.length.toString(16)}-${crypto.createHash('sha1').update(data).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    });
    res.end(data);
  });
}

// ---------- rutare API ----------

async function handleApi(req, res, pathname, query) {
  try {
    // limita generala, pe orice cerere -- protejeaza serverul (un singur
    // proces) de bombardare, accidentala sau intentionata
    if (isRateLimited('general', req, 300, 60 * 1000)) {
      return sendJSON(res, 429, { error: 'Prea multe cereri. Încearcă din nou peste puțin timp.' });
    }

    // ---- auth ----

    if (pathname === '/api/public/contact' && req.method === 'POST') {
      if (isRateLimited('contact', req, 5, 10 * 60 * 1000)) {
        return sendJSON(res, 429, { error: 'Prea multe mesaje trimise. Încearcă din nou mai târziu.' });
      }
      const body = await readBody(req);
      const name = (body.name || '').trim();
      const email = (body.email || '').trim();
      const message = (body.message || '').trim();
      if (!name || !email || !message) {
        return sendJSON(res, 400, { error: 'Toate câmpurile sunt obligatorii.' });
      }
      if (message.length > 5000) {
        return sendJSON(res, 400, { error: 'Mesajul e prea lung.' });
      }
      const result = db.createContactMessage({ name, email, message });
      return sendJSON(res, 201, result);
    }

    if (pathname === '/api/signup' && req.method === 'POST') {
      if (isRateLimited('signup', req, 5, 10 * 60 * 1000)) {
        return sendJSON(res, 429, { error: 'Prea multe încercări. Încearcă din nou mai târziu.' });
      }
      const body = await readBody(req);
      const companyName = (body.companyName || '').trim();
      const agentName = (body.agentName || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      if (!companyName || !agentName || !email || !password) {
        return sendJSON(res, 400, { error: 'Toate câmpurile sunt obligatorii (nume companie, nume, email, parolă).' });
      }
      if (password.length < 8) {
        return sendJSON(res, 400, { error: 'Parola trebuie să aibă cel puțin 8 caractere.' });
      }
      if (db.findAgentByEmail(email)) {
        return sendJSON(res, 409, { error: 'Există deja un cont cu acest email.' });
      }
      try {
        const { company, agent } = db.createCompany({ companyName, agentName, email, password });
        const token = createSession(agent.id);
        res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Secure; Path=/; SameSite=Lax`);
        return sendJSON(res, 201, { company, agent });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = (body.email || '').trim().toLowerCase();
      if (!email) return sendJSON(res, 400, { error: 'Email lipsă' });

      const lockout = checkLockout(email);
      if (lockout.locked) {
        return sendJSON(res, 429, { error: `Prea multe încercări eșuate. Încearcă din nou peste ${lockout.minutesLeft} minut(e).` });
      }

      const agent = db.verifyAgentByEmail(email, body.password);
      if (!agent) {
        registerFailedAttempt(email);
        return sendJSON(res, 401, { error: 'Credențiale invalide' });
      }
      clearFailedAttempts(email);
      const token = createSession(agent.id);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Secure; Path=/; SameSite=Lax`);
      return sendJSON(res, 200, agent);
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const cookie = req.headers.cookie || '';
      const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
      if (match) sessions.delete(match[1]);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/forgot-password' && req.method === 'POST') {
      if (isRateLimited('forgot-password', req, 5, 10 * 60 * 1000)) {
        return sendJSON(res, 429, { error: 'Prea multe încercări. Încearcă din nou peste câteva minute.' });
      }
      const body = await readBody(req);
      const email = (body.email || '').trim().toLowerCase();
      // raspundem la fel, indiferent daca emailul exista sau nu -- altfel am
      // dezvalui, prin timpul de raspuns sau mesaj, ce conturi sunt reale
      const genericResponse = { ok: true, message: 'Dacă adresa există în sistem, vei primi un email cu instrucțiuni.' };
      try {
        const agent = db.findAgentByEmail(email);
        if (agent && agent.active && resend.isConfigured()) {
          const token = db.createPasswordResetToken(agent.id);
          const resetUrl = `${process.env.APP_BASE_URL || 'https://www.easy-ticket.ro'}/#/reset-password?token=${token}`;
          await resend.sendEmail({
            to: email,
            subject: 'Resetare parolă — Easy-Ticket',
            html: `<p>Salut, ${agent.name ? agent.name.split(' ')[0] : ''}!</p><p>Cineva (probabil tu) a cerut resetarea parolei contului tău Easy-Ticket.</p><p><a href="${resetUrl}">Apasă aici ca să-ți alegi o parolă nouă</a> — linkul e valabil o oră.</p><p>Dacă nu ai cerut tu asta, poți ignora acest email — parola ta rămâne neschimbată.</p>`,
          });
        }
      } catch (e) {
        // nu dezvaluim eroarea exacta catre client (ar putea confirma existenta contului) -- doar logam
        console.error('Eroare la trimiterea emailului de resetare:', e.message);
      }
      return sendJSON(res, 200, genericResponse);
    }

    if (pathname === '/api/reset-password' && req.method === 'POST') {
      if (isRateLimited('reset-password', req, 10, 10 * 60 * 1000)) {
        return sendJSON(res, 429, { error: 'Prea multe încercări. Încearcă din nou peste câteva minute.' });
      }
      const body = await readBody(req);
      const token = (body.token || '').trim();
      const password = body.password || '';
      if (!token) return sendJSON(res, 400, { error: 'Token lipsă.' });
      if (password.length < 8) return sendJSON(res, 400, { error: 'Parola trebuie să aibă minimum 8 caractere.' });
      const agent = db.resetPasswordWithToken(token, password);
      if (!agent) return sendJSON(res, 400, { error: 'Link invalid sau expirat. Cere un link nou.' });
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const agent = getAgentFromRequest(req);
      if (!agent || !agent.active) return sendJSON(res, 401, { error: 'Neautentificat' });
      const { passwordHash, password, ...safe } = agent;
      return sendJSON(res, 200, { ...safe, active: !!safe.active, isPlatformAdmin: isPlatformAdminRequest(req) });
    }

    // ---- panoul de administrare al platformei (creatorul platformei, nu un manager de companie) ----

    if (pathname === '/api/platform-admin/login' && req.method === 'POST') {
      if (isRateLimited('platform-admin-login', req, 5, 10 * 60 * 1000)) {
        return sendJSON(res, 429, { error: 'Prea multe încercări. Încearcă din nou peste câteva minute.' });
      }
      const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD;
      if (!adminPassword) {
        return sendJSON(res, 503, { error: 'Panoul de administrare nu este configurat pe server (lipsește PLATFORM_ADMIN_PASSWORD).' });
      }
      const body = await readBody(req);
      if (body.password !== adminPassword) {
        return sendJSON(res, 401, { error: 'Parolă incorectă.' });
      }
      // sesiunea de admin platforma (pentru rutele de administrare companii)...
      const adminToken = createPlatformAdminSession();
      const testAgent = db.getOrCreatePlatformTestCompany();
      res.setHeader('Set-Cookie', [
        `platformAdminSession=${adminToken}; HttpOnly; Secure; Path=/; SameSite=Lax`,
        // ...SI, in aceeasi logare, o sesiune normala de agent (compania de test
        // dedicata), ca sa poata folosi imediat toata platforma, din acelasi cont
        `session=${createSession(testAgent.id)}; HttpOnly; Secure; Path=/; SameSite=Lax`,
      ]);
      const { passwordHash, password, ...safeAgent } = testAgent;
      return sendJSON(res, 200, { ...safeAgent, active: !!safeAgent.active, isPlatformAdmin: true });
    }

    if (pathname === '/api/platform-admin/session' && req.method === 'GET') {
      if (!isPlatformAdminRequest(req)) return sendJSON(res, 401, { error: 'Neautentificat' });
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/platform-admin/logout' && req.method === 'POST') {
      const cookieHeader = req.headers.cookie || '';
      const match = cookieHeader.match(/(?:^|;\s*)platformAdminSession=([^;]+)/);
      if (match) platformAdminSessions.delete(match[1]);
      res.setHeader('Set-Cookie', 'platformAdminSession=; HttpOnly; Secure; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/platform-admin/companies' && req.method === 'GET') {
      if (!isPlatformAdminRequest(req)) return sendJSON(res, 401, { error: 'Neautentificat' });
      return sendJSON(res, 200, db.listAllCompaniesForAdmin());
    }

    if (pathname === '/api/platform-admin/clients' && req.method === 'GET') {
      if (!isPlatformAdminRequest(req)) return sendJSON(res, 401, { error: 'Neautentificat' });
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(20000, Math.max(1, Number(query.pageSize) || 100));
      return sendJSON(res, 200, db.getAllPlatformClients({
        page, pageSize, q: query.q || '', companyId: query.companyId || null,
      }));
    }

    // Magazinele, cu cati clienti unici are fiecare -- randul de filtre de
    // deasupra listei. Separat de lista propriu-zisa: nu se schimba la
    // fiecare pagina, deci nu are rost recalculat la fiecare navigare.
    if (pathname === '/api/platform-admin/client-companies' && req.method === 'GET') {
      if (!isPlatformAdminRequest(req)) return sendJSON(res, 401, { error: 'Neautentificat' });
      return sendJSON(res, 200, db.listPlatformClientCompanies());
    }

    const toggleCompanyMatch = pathname.match(/^\/api\/platform-admin\/companies\/([^/]+)\/active$/);
    if (toggleCompanyMatch && req.method === 'POST') {
      if (!isPlatformAdminRequest(req)) return sendJSON(res, 401, { error: 'Neautentificat' });
      const body = await readBody(req);
      const ok = db.setCompanyActive(toggleCompanyMatch[1], Boolean(body.active));
      if (!ok) return sendJSON(res, 404, { error: 'Companie negăsită' });
      return sendJSON(res, 200, { ok: true });
    }

    // toate rutele de mai jos necesită autentificare
    const currentAgent = getAgentFromRequest(req);
    if (!currentAgent || !currentAgent.active) return sendJSON(res, 401, { error: 'Neautentificat' });

    const requireManager = () => currentAgent.role === 'manager';

    // ---------- pragul de istoric ----------
    // Paginile de zi cu zi (Comenzi, statistici, profil client) arata doar
    // comenzile din ziua inscrierii magazinului incoace. Istoricul importat
    // dinainte exista si e al magazinului -- il vede in tabul "Clienți totali",
    // care trimite scope=all. Nu e o restrictie de securitate, ci un filtru
    // implicit: altfel, un magazin cu 900.000 de comenzi vechi si-ar ineca
    // paginile de lucru.
    // datele companiei (inclusiv credentialele decriptate GLS/Sameday/MerchantPro) --
    // preluate o singura data, disponibile pentru toate rutele de mai jos
    const company = db.getCompany(currentAgent.companyId);
    const historyCutoff = pragComenzi(company);
    const wantsFullHistory = query.scope === 'all';
    const orderCutoff = wantsFullHistory ? undefined : historyCutoff;

    if (pathname === '/api/categories' && req.method === 'GET') {
      return sendJSON(res, 200, db.listCategories(currentAgent.companyId));
    }

    if (pathname === '/api/categories' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot gestiona categoriile' });
      const body = await readBody(req);
      try {
        return sendJSON(res, 201, db.addCategory(currentAgent.companyId, body.name));
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    const categoryMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
    if (categoryMatch && req.method === 'DELETE') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot gestiona categoriile' });
      return sendJSON(res, 200, db.removeCategory(currentAgent.companyId, decodeURIComponent(categoryMatch[1])));
    }

    // ---- lista simpla de agenti (pt dropdown-uri de asignare, orice agent autentificat) ----

    if (pathname === '/api/agents' && req.method === 'GET') {
      return sendJSON(res, 200, db.listAgents(currentAgent.companyId));
    }

    // ---- administrare agenti (doar manageri) ----

    if (pathname === '/api/admin/agents' && req.method === 'GET') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot accesa administrarea' });
      return sendJSON(res, 200, db.listAgents(currentAgent.companyId, { includeInactive: true }));
    }

    if (pathname === '/api/admin/agents' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot accesa administrarea' });
      const body = await readBody(req);
      if (!body.name || !body.email || !body.password || !body.role) {
        return sendJSON(res, 400, { error: 'Câmpuri obligatorii lipsă (nume, email, parolă, rol)' });
      }
      if (body.password.length < 6) {
        return sendJSON(res, 400, { error: 'Parola trebuie să aibă minimum 6 caractere' });
      }
      try {
        const agent = db.createAgent(currentAgent.companyId, body);
        return sendJSON(res, 201, agent);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    const adminAgentMatch = pathname.match(/^\/api\/admin\/agents\/([^/]+)$/);
    if (adminAgentMatch && req.method === 'PATCH') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot accesa administrarea' });
      const body = await readBody(req);
      if (body.password && body.password.length < 6) {
        return sendJSON(res, 400, { error: 'Parola trebuie să aibă minimum 6 caractere' });
      }
      try {
        const agent = db.updateAgent(currentAgent.companyId, adminAgentMatch[1], body);
        if (!agent) return sendJSON(res, 404, { error: 'Agent negăsit' });
        return sendJSON(res, 200, agent);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    // ---- setari companie (credentiale curieri/MerchantPro, doar manageri) ----

    if (pathname === '/api/company/settings' && req.method === 'GET') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot accesa setările companiei' });
      const company = db.getCompany(currentAgent.companyId);
      if (!company) return sendJSON(res, 404, { error: 'Companie negăsită' });
      // secretele nu se trimit niciodata in clar catre browser -- doar daca sunt setate sau nu
      const { merchantProApiSecret, glsPassword, samedayPassword, gomagApiKey, pttPassword, ...rest } = company;
      return sendJSON(res, 200, {
        ...rest,
        merchantProApiSecretSet: Boolean(merchantProApiSecret),
        glsPasswordSet: Boolean(glsPassword),
        samedayPasswordSet: Boolean(samedayPassword),
        gomagApiKeySet: Boolean(gomagApiKey),
        pttPasswordSet: Boolean(pttPassword),
      });
    }

    if (pathname === '/api/company/settings' && req.method === 'PATCH') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot modifica setările companiei' });
      const body = await readBody(req);
      // campurile de secret (parole/chei) se actualizeaza DOAR daca vin nevide in cerere --
      // camp gol in formular inseamna "pastreaza valoarea existenta", nu "sterge-o"
      const patch = { ...body };
      if (patch.merchantProApiSecret === '') delete patch.merchantProApiSecret;
      if (patch.glsPassword === '') delete patch.glsPassword;
      if (patch.samedayPassword === '') delete patch.samedayPassword;
      if (patch.gomagApiKey === '') delete patch.gomagApiKey;
      if (patch.pttPassword === '') delete patch.pttPassword;

      // Data de la care comenzile apar in paginile de lucru. Se completeaza
      // singura cand magazinul se conecteaza prima data, deci nu are camp in
      // Setari -- ruta o accepta totusi, ca sa poata fi corectata punctual un
      // magazin conectat inainte ca mecanismul sa existe. Se trimite o zi
      // calendaristica ("2026-09-12"), transformata in ora 00:00 din Romania;
      // sir gol = revenire la comportamentul automat.
      if (patch.ordersVisibleFrom !== undefined) {
        const zi = String(patch.ordersVisibleFrom).trim();
        if (!zi) {
          patch.ordersVisibleFrom = null;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(zi)) {
          const moment = inceputZiRomaneascaISO(zi);
          if (!moment) return sendJSON(res, 400, { error: 'Dată invalidă pentru afișarea comenzilor.' });
          patch.ordersVisibleFrom = moment;
        } else {
          return sendJSON(res, 400, { error: 'Data de la care apar comenzile trebuie să fie în formatul AAAA-LL-ZZ.' });
        }
      }

      // retinem starea DINAINTE de salvare, ca sa detectam daca MerchantPro
      // sau GoMag tocmai au fost configurate pentru PRIMA DATA -- caz in
      // care pornim automat, silentios, importul complet de istoric (clientul
      // nu vede un buton sau progres detaliat, doar un mesaj general, ca ii
      // "pregatim contul")
      const wasMpConfigured = mp.isConfigured(company);
      const wasGomagConfigured = gomag.isConfigured(company);

      let updated = db.updateCompanyCredentials(currentAgent.companyId, patch);
      const merchantProJustConfigured = !wasMpConfigured && mp.isConfigured(updated);
      const gomagJustConfigured = !wasGomagConfigured && gomag.isConfigured(updated);
      if (merchantProJustConfigured || gomagJustConfigured) {
        // Magazinul tocmai s-a conectat: de aici incolo comenzile intra in
        // paginile de lucru, iar tot ce aduce importul din trecutul lui ramane
        // in "Clienți totali". Nu suprascriem o data pusa deja (manual sau la
        // o conectare anterioara).
        if (!updated.ordersVisibleFrom) {
          const prag = inceputZileiPentru(new Date().toISOString());
          // reluam rezultatul in `updated`, altfel raspunsul catre interfata ar
          // pleca cu valoarea dinainte de aceasta scriere
          if (prag) updated = db.updateCompanyCredentials(currentAgent.companyId, { ordersVisibleFrom: prag });
        }
        fullHistoryImport.maybeStartAutoImport(updated, { merchantProJustConfigured, gomagJustConfigured });
      }

      const { merchantProApiSecret, glsPassword, samedayPassword, gomagApiKey, pttPassword, ...rest } = updated;
      return sendJSON(res, 200, {
        ...rest,
        merchantProApiSecretSet: Boolean(merchantProApiSecret),
        glsPasswordSet: Boolean(glsPassword),
        samedayPasswordSet: Boolean(samedayPassword),
        gomagApiKeySet: Boolean(gomagApiKey),
        pttPasswordSet: Boolean(pttPassword),
        accountPreparing: merchantProJustConfigured || gomagJustConfigured,
      });
    }

    const toggleIntegrationMatch = pathname.match(/^\/api\/company\/integrations\/([^/]+)\/active$/);
    if (toggleIntegrationMatch && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot activa/dezactiva integrările.' });
      const integration = toggleIntegrationMatch[1];
      if (!['merchantpro', 'gomag', 'gls', 'sameday'].includes(integration)) {
        return sendJSON(res, 400, { error: 'Integrare necunoscută.' });
      }
      const body = await readBody(req);
      const updated = db.setIntegrationActive(currentAgent.companyId, integration, Boolean(body.active));
      const { merchantProApiSecret, glsPassword, samedayPassword, gomagApiKey, ...rest } = updated;
      return sendJSON(res, 200, rest);
    }

    if (pathname === '/api/company/settings/sameday-autofill' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot accesa setările companiei' });
      const body = await readBody(req);
      if (!body.samedayUsername || !body.samedayPassword) {
        return sendJSON(res, 400, { error: 'Completează mai întâi utilizatorul și parola Sameday, apoi încearcă din nou.' });
      }
      // obiect temporar, testat direct la Sameday -- NU se salveaza in baza de
      // date aici (asta se intampla doar la apasarea "Salveaza setarile").
      // id unic, ca sa nu interfereze cu tokenul real, cacheat al companiei.
      const draftCompany = {
        id: `${currentAgent.companyId}:draft:${Date.now()}`,
        samedayUsername: body.samedayUsername,
        samedayPassword: body.samedayPassword,
        samedayPickupPointId: body.samedayPickupPointId || '',
        samedayPickupPointAddress: body.samedayPickupPointAddress || '',
      };
      try {
        const points = await sameday.getPickupPoints(draftCompany);
        let point;
        if (draftCompany.samedayPickupPointId) {
          point = points.find((p) => String(p.id) === String(draftCompany.samedayPickupPointId));
          if (!point) {
            return sendJSON(res, 400, { error: `Nu am găsit punctul de ridicare cu ID-ul ${draftCompany.samedayPickupPointId}. Puncte disponibile: ${points.map((p) => `${p.id} (${p.alias || p.address})`).join(', ')}` });
          }
        } else {
          point = points.find((p) => p.defaultPickupPoint) || points[0];
          if (!point) return sendJSON(res, 400, { error: 'Contul Sameday nu are niciun punct de ridicare configurat.' });
        }
        const contacts = point.pickupPointContactPerson || [];
        const contact = contacts.find((c) => c.defaultContactPerson) || contacts[0];
        return sendJSON(res, 200, {
          samedayPickupPointId: String(point.id),
          samedayPickupPointAddress: point.address || '',
          samedaySenderName: contact?.name || point.alias || '',
          samedaySenderPhone: contact?.phoneNumber || '',
          samedaySenderPostalCode: point.postalCode || point.zipCode || '',
          samedaySenderAddress: point.address || '',
          samedayContactPersonId: contact?.id ? String(contact.id) : '',
        });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    // Serviciile disponibile pe contul PTT Express al companiei -- citite live
    // de la ei, ca sa poata fi alese dintr-o lista in Setari, nu scrise de mana.
    // Se poate apela si inainte de salvare (cu credentialele din formular);
    // daca parola e goala, folosim pe cea deja salvata.
    if (pathname === '/api/company/settings/ptt-services' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot accesa setările companiei' });
      const body = await readBody(req);
      const draftCompany = {
        ...company,
        pttUsername: body.pttUsername || company.pttUsername,
        pttPassword: body.pttPassword || company.pttPassword,
        pttSenderName: body.pttSenderName || company.pttSenderName,
        pttSenderAddress: body.pttSenderAddress || company.pttSenderAddress,
        pttSenderCity: body.pttSenderCity || company.pttSenderCity,
        pttSenderPostalCode: body.pttSenderPostalCode || company.pttSenderPostalCode,
        pttSenderPhone: body.pttSenderPhone || company.pttSenderPhone,
        pttSenderEmail: body.pttSenderEmail || company.pttSenderEmail,
      };
      if (!draftCompany.pttUsername || !draftCompany.pttPassword) {
        return sendJSON(res, 400, { error: 'Completează mai întâi utilizatorul și parola PTT Express, apoi încearcă din nou.' });
      }
      try {
        return sendJSON(res, 200, { services: await pttexpress.getAvailableServices(draftCompany) });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    // ---------- ștergerea contului de companie (GDPR art. 17) ----------

    // Exportul complet al datelor, înainte de ștergere. Scris în flux, lot cu
    // lot: la sute de mii de comenzi, un JSON construit întâi în memorie ar
    // depăși memoria serverului.
    if (pathname === '/api/company/export' && req.method === 'GET') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot exporta datele companiei' });
      const header = db.getCompanyExportHeader(currentAgent.companyId);
      if (!header) return sendJSON(res, 404, { error: 'Companie negăsită' });

      const stamp = new Date().toISOString().slice(0, 10);
      const safeName = String(company.name || 'companie').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'companie';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="export-${safeName}-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });

      // scriere cu respectarea contrapresiunii -- altfel, la volum mare,
      // rândurile se adună în buffer-ul de socket, în memorie
      const write = (chunk) => new Promise((resolve, reject) => {
        if (res.write(chunk)) return resolve();
        res.once('drain', resolve);
        res.once('error', reject);
      });

      try {
        await write('{\n');
        await write(`"exportedAt": ${JSON.stringify(new Date().toISOString())},\n`);
        await write(`"company": ${JSON.stringify(header)},\n`);
        await write('"_note": "Fotografiile atașate tichetelor și fișierele PDF ale AWB-urilor nu sunt incluse (conținut binar). Parolele conturilor și cheile de integrare nu sunt exportate.",\n');

        let openSection = null;
        let rowsInSection = 0;
        for (const chunk of db.iterateCompanyExport(currentAgent.companyId, { batchSize: 500 })) {
          if (chunk.section !== openSection) {
            if (openSection) await write('\n],\n');
            await write(`${JSON.stringify(chunk.section)}: [`);
            openSection = chunk.section;
            rowsInSection = 0;
          }
          let buf = '';
          for (const row of chunk.rows) {
            buf += (rowsInSection ? ',\n' : '\n') + JSON.stringify(row);
            rowsInSection += 1;
          }
          if (buf) await write(buf);
        }
        if (openSection) await write('\n]\n');
        await write('}\n');
        res.end();
      } catch (e) {
        // răspunsul e deja pornit, nu mai putem trimite un cod de eroare
        try { res.end(`\n/* EXPORT INCOMPLET: ${String(e.message).replace(/\*\//g, '')} */`); } catch (e2) { /* conexiune deja închisă */ }
      }
      return;
    }

    // Ștergerea propriu-zisă. Ireversibilă, imediată.
    if (pathname === '/api/company/delete' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot șterge contul companiei' });
      const body = await readBody(req);

      // dublă confirmare: parola contului + numele exact al companiei
      if (!body.password || !db.verifyAgent(currentAgent.id, body.password)) {
        return sendJSON(res, 403, { error: 'Parolă incorectă.' });
      }
      const typed = String(body.confirmName || '').trim();
      if (typed.toLowerCase() !== String(company.name || '').trim().toLowerCase()) {
        return sendJSON(res, 400, { error: 'Numele companiei nu se potrivește. Scrie-l exact așa cum apare mai sus.' });
      }

      // sesiunile tuturor colegilor din companie, invalidate înainte de
      // ștergere -- altfel ar rămâne active până la expirare, cu un cont
      // care nu mai există
      const agentIds = new Set(db.listAgents(currentAgent.companyId, { includeInactive: true }).map((a) => a.id));
      for (const [token, entry] of sessions) {
        if (agentIds.has(entry.agentId)) sessions.delete(token);
      }

      let result;
      try {
        result = db.deleteCompanyCompletely(currentAgent.companyId);
      } catch (e) {
        return sendJSON(res, 500, { error: `Ștergerea nu a putut fi finalizată: ${e.message}` });
      }
      if (!result) return sendJSON(res, 404, { error: 'Companie negăsită' });

      console.log(`Cont șters definitiv: ${result.companyName} (${currentAgent.companyId})`, result.deleted);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true, deleted: result.deleted });
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      return sendJSON(res, 200, db.getStats(currentAgent.companyId));
    }

    if (pathname === '/api/tickets' && req.method === 'GET') {
      const filters = {
        status: query.status || undefined,
        priority: query.priority || undefined,
        category: query.category || undefined,
        section: query.section || undefined,
        assignedTo: query.assignedTo || undefined,
        dateFrom: query.dateFrom || undefined,
        dateTo: query.dateTo || undefined,
        q: query.q || undefined,
        sort: query.sort || undefined,
      };
      return sendJSON(res, 200, db.listTickets(currentAgent.companyId, filters));
    }

    if (pathname === '/api/tickets' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.subject || !body.description || !body.requesterName || !body.category) {
        return sendJSON(res, 400, { error: 'Câmpuri obligatorii lipsă (subiect, descriere, solicitant, categorie)' });
      }
      const ticket = db.createTicket(currentAgent.companyId, body);
      return sendJSON(res, 201, ticket);
    }

    const ticketMatch = pathname.match(/^\/api\/tickets\/([^/]+)$/);
    if (ticketMatch && req.method === 'GET') {
      const ticket = db.getTicket(currentAgent.companyId, ticketMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      return sendJSON(res, 200, ticket);
    }

    if (ticketMatch && req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        const ticket = db.updateTicket(currentAgent.companyId, ticketMatch[1], body, currentAgent);
        if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
        return sendJSON(res, 200, ticket);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    const commentMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/comments$/);
    if (commentMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.body || !body.body.trim()) {
        return sendJSON(res, 400, { error: 'Comentariul nu poate fi gol' });
      }
      const comment = db.addComment(currentAgent.companyId, commentMatch[1], {
        authorId: currentAgent.id,
        authorName: currentAgent.name,
        body: body.body,
        internal: body.internal,
      });
      if (!comment) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      return sendJSON(res, 201, comment);
    }

    // ---- comenzi (MerchantPro) ----

    if (pathname === '/api/orders/sync-status' && req.method === 'GET') {
      const status = orderSync.getSyncStatus(company);
      let platformLabel = 'MERCHANTPRO';
      const urlToLabel = (url) => {
        try {
          const host = new URL(url || '').hostname;
          const bareHost = host.replace(/^www\./, '').split('.')[0];
          return bareHost ? bareHost.toUpperCase() : null;
        } catch (e) { return null; }
      };
      // preferam sursa care e chiar configurata -- daca ambele sunt setate
      // (rar), MerchantPro ramane implicit, pentru compatibilitate
      if (mp.isConfigured(company)) {
        platformLabel = urlToLabel(company.merchantProShopUrl) || platformLabel;
      } else if (gomag.isConfigured(company)) {
        platformLabel = urlToLabel(company.gomagShopUrl) || 'GOMAG';
      }
      return sendJSON(res, 200, { ...status, platformLabel });
    }

    if (pathname === '/api/orders/sync' && req.method === 'POST') {
      try {
        const result = mp.isConfigured(company) ? await orderSync.runSyncForCompany(company) : null;
        const gomagResult = gomag.isConfigured(company) ? await orderSync.runGomagSyncForCompany(company) : null;
        return sendJSON(res, 200, { ...result, gomag: gomagResult });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    if (pathname === '/api/orders/import-full-history' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot porni importul complet.' });
      if (!mp.isConfigured(company)) return sendJSON(res, 400, { error: 'Integrarea MerchantPro nu este configurată.' });
      const result = fullHistoryImport.runFullHistoryImport(company);
      return sendJSON(res, 200, result);
    }

    if (pathname === '/api/orders/import-full-history/resume' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot relua importul.' });
      if (!mp.isConfigured(company)) return sendJSON(res, 400, { error: 'Integrarea MerchantPro nu este configurată.' });
      const result = fullHistoryImport.resumeFullHistoryImport(company);
      return sendJSON(res, 200, result);
    }

    if (pathname === '/api/orders/import-full-history/status' && req.method === 'GET') {
      return sendJSON(res, 200, fullHistoryImport.getImportStatus(company));
    }

    if (pathname === '/api/orders/stats' && req.method === 'GET') {
      return sendJSON(res, 200, db.getOrderStats(currentAgent.companyId, { dateFrom: query.dateFrom || undefined, dateTo: query.dateTo || undefined, minDateCreated: orderCutoff }));
    }

    if (pathname === '/api/product-analytics' && req.method === 'GET') {
      return sendJSON(res, 200, db.getProductAnalytics(currentAgent.companyId, { dateFrom: query.dateFrom || undefined, dateTo: query.dateTo || undefined }));
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
      // limita implicita SIGURA -- indiferent ce trimite (sau nu) interfata,
      // niciodata nu incarcam toate comenzile deodata (pot fi zeci de mii)
      const pageSize = Math.min(Number(query.pageSize) || 200, 500);
      const page = Math.max(Number(query.page) || 1, 1);
      const filters = {
        shippingStatus: query.shippingStatus || undefined,
        paymentStatus: query.paymentStatus || undefined,
        internalStatus: query.internalStatus || undefined,
        assignedTo: query.assignedTo || undefined,
        needsAwb: query.needsAwb === '1' ? true : undefined,
        hasAwb: query.needsAwb === '0' ? true : undefined,
        dateFrom: query.dateFrom || undefined,
        dateTo: query.dateTo || undefined,
        q: query.q || undefined,
        minDateCreated: orderCutoff,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      };
      return sendJSON(res, 200, db.listOrders(currentAgent.companyId, filters));
    }

    // Cate comenzi corespund filtrelor -- doar numarul, pentru paginare.
    // Folosita de tabul de istoric complet, care poate avea sute de mii de
    // randuri si are nevoie sa stie cate pagini sunt.
    if (pathname === '/api/orders/count' && req.method === 'GET') {
      return sendJSON(res, 200, {
        total: db.countOrders(currentAgent.companyId, {
          shippingStatus: query.shippingStatus || undefined,
          paymentStatus: query.paymentStatus || undefined,
          internalStatus: query.internalStatus || undefined,
          assignedTo: query.assignedTo || undefined,
          needsAwb: query.needsAwb === '1' ? true : undefined,
          hasAwb: query.needsAwb === '0' ? true : undefined,
          dateFrom: query.dateFrom || undefined,
          dateTo: query.dateTo || undefined,
          q: query.q || undefined,
          minDateCreated: orderCutoff,
        }),
        historyCutoff: historyCutoff || null,
        // ziua de la care comenzile apar in paginile de lucru -- nu data
        // crearii contului, care poate fi cu mult inainte
        signupDate: historyCutoff || (company && company.createdAt) || null,
        signupDay: ziRomaneasca(historyCutoff || (company && company.createdAt)),
        // indexul de cautare intoarce cel mult 5.000 de potriviri (plafon pus
        // ca sortarea sa ramana rapida la sute de mii de comenzi), deci la o
        // cautare foarte larga numarul e "cel putin atat", nu exact
        capped: Boolean(query.q) ,
      });
    }

    const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && req.method === 'GET') {
      const order = db.getOrder(currentAgent.companyId, orderMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      return sendJSON(res, 200, order);
    }

    if (orderMatch && req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        const order = db.updateOrderInternal(currentAgent.companyId, orderMatch[1], body, currentAgent);
        if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
        return sendJSON(res, 200, order);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    const orderNoteMatch = pathname.match(/^\/api\/orders\/([^/]+)\/notes$/);
    if (orderNoteMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.body || !body.body.trim()) return sendJSON(res, 400, { error: 'Notița nu poate fi goală' });
      const note = db.addOrderNote(currentAgent.companyId, orderNoteMatch[1], { agentId: currentAgent.id, agentName: currentAgent.name, body: body.body });
      if (!note) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      return sendJSON(res, 201, note);
    }

    const orderTicketsMatch = pathname.match(/^\/api\/orders\/([^/]+)\/tickets$/);
    if (orderTicketsMatch && req.method === 'GET') {
      return sendJSON(res, 200, db.getTicketsForOrder(currentAgent.companyId, orderTicketsMatch[1]));
    }

    const issueInvoiceMatch = pathname.match(/^\/api\/orders\/([^/]+)\/issue-invoice$/);
    if (issueInvoiceMatch && req.method === 'POST') {
      if (!mp.isConfigured(company)) return sendJSON(res, 400, { error: 'Integrarea MerchantPro nu este configurată pentru compania ta — completeaz-o în Setări.' });
      const order = db.getOrder(currentAgent.companyId, issueInvoiceMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      try {
        await mp.issueInvoice(company, order.mpId);
        // factura nu vine in raspunsul de mai sus -- resincronizam comanda ca sa o preluam
        const fresh = await mp.getOrder(company, order.mpId);
        db.upsertOrderFromMerchantPro(currentAgent.companyId, fresh);
        return sendJSON(res, 200, db.getOrder(currentAgent.companyId, order.id));
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    // ---- AWB / curier GLS ----

    if (pathname === '/api/gls/status' && req.method === 'GET') {
      return sendJSON(res, 200, { configured: gls.isConfigured(company) });
    }

    if (pathname === '/api/sameday/status' && req.method === 'GET') {
      return sendJSON(res, 200, { configured: sameday.isConfigured(company) });
    }

    if (pathname === '/api/ptt/status' && req.method === 'GET') {
      return sendJSON(res, 200, { configured: pttexpress.isConfigured(company) });
    }

    const generateAwbMatch = pathname.match(/^\/api\/orders\/([^/]+)\/generate-awb$/);
    if (generateAwbMatch && req.method === 'POST') {
      if (!gls.isConfigured(company)) return sendJSON(res, 400, { error: 'Integrarea GLS nu este configurată pentru compania ta — completeaz-o în Setări.' });
      const order = db.getOrder(currentAgent.companyId, generateAwbMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      if (!order.shippingAddress || !order.shippingCity || !order.shippingPostalCode || !order.shippingPhone) {
        return sendJSON(res, 400, { error: 'Comanda nu are adresă/telefon complete — verifică datele înainte de a genera AWB.' });
      }
      try {
        const isCod = (order.paymentStatus === 'awaiting');
        const result = await gls.createParcel(company, {
          mpId: order.mpId,
          codAmount: isCod ? order.totalAmount : 0,
          currency: order.currency,
          shippingName: order.shippingName || order.billingName,
          shippingAddress: order.shippingAddress,
          shippingPostalCode: order.shippingPostalCode,
          shippingCity: order.shippingCity,
          shippingPhone: order.shippingPhone,
          customerEmail: order.customerEmail,
        });
        const updated = db.updateOrderInternal(currentAgent.companyId, order.id, {
          awbCourier: 'GLS',
          awbNumber: result.trackingNumber,
          awbParcelId: result.parcelId,
          // salvam PDF-ul local, o singura data, cat timp GLS chiar ni-l da --
          // re-cererea lui de la GLS ulterior s-a dovedit nesigura (vezi getLabelPdf)
          awbLabelPdf: result.labelPdf ? result.labelPdf.toString('base64') : undefined,
          internalStatus: 'awb_generated',
        }, currentAgent);
        // incercam si sa scriem AWB-ul inapoi in MerchantPro, dar nu blocam raspunsul daca esueaza
        if (mp.isConfigured(company)) {
          mp.updateOrder(company, order.mpId, { shipping_awb: result.trackingNumber }).catch((e) => {
            console.error('Nu am putut scrie AWB-ul înapoi în MerchantPro:', e.message);
          });
        }
        return sendJSON(res, 200, { ...updated, labelAvailable: Boolean(result.labelPdf) });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const cancelAwbMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel-awb$/);
    if (cancelAwbMatch && req.method === 'POST') {
      const order = db.getOrder(currentAgent.companyId, cancelAwbMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      if (!order.awbParcelId) return sendJSON(res, 400, { error: 'Comanda nu are AWB generat.' });
      try {
        await gls.deleteParcel(company, order.awbParcelId);
        const updated = db.updateOrderInternal(currentAgent.companyId, order.id, {
          awbNumber: null,
          awbParcelId: null,
          awbLabelPdf: null,
          awbCourier: null,
          internalStatus: 'processing',
        }, currentAgent);
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const labelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/awb-label$/);
    if (labelMatch && req.method === 'GET') {
      const order = db.getOrder(currentAgent.companyId, labelMatch[1]);
      if (!order || !order.awbParcelId) return sendJSON(res, 404, { error: 'Nu există AWB pentru această comandă.' });

      // servim eticheta salvata local, daca exista -- e mult mai fiabil decat
      // sa o cerem din nou de la GLS (unele operatii GLS de "re-extragere"
      // s-au dovedit sa raspunda cu eroare pentru colete deja emise)
      if (order.awbLabelPdf) {
        const pdfBuffer = Buffer.from(order.awbLabelPdf, 'base64');
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="awb-${order.awbNumber}.pdf"`,
          'Content-Length': pdfBuffer.length,
        });
        return res.end(pdfBuffer);
      }

      try {
        const pdfBuffer = await gls.getLabelPdf(company, order.awbParcelId);
        db.updateOrderInternal(currentAgent.companyId, order.id, { awbLabelPdf: pdfBuffer.toString('base64') }, currentAgent);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="awb-${order.awbNumber}.pdf"`,
          'Content-Length': pdfBuffer.length,
        });
        return res.end(pdfBuffer);
      } catch (e) {
        return sendJSON(res, 502, {
          error: `Eticheta nu e salvată local, iar re-cererea ei de la GLS a eșuat (${e.message}). Cel mai sigur pas acum: anulează acest AWB și generează unul nou — data viitoare eticheta se va salva automat local, la creare.`,
        });
      }
    }

    // ---- AWB de ridicare de la client (Service / Retur) ----

    const generatePickupMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/generate-pickup-awb$/);
    if (generatePickupMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, generatePickupMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });

      const body = await readBody(req);
      const reason = ['retur', 'schimb'].includes(body.reason) ? body.reason : 'service';
      const courier = ['sameday', 'ptt'].includes(body.courier) ? body.courier : 'gls';
      const courierClient = courier === 'sameday' ? sameday : (courier === 'ptt' ? pttexpress : gls);
      const courierLabel = courier === 'sameday' ? 'Sameday' : (courier === 'ptt' ? 'PTT Express' : 'GLS');

      if (!courierClient.isConfigured(company)) {
        return sendJSON(res, 400, { error: `Integrarea ${courierLabel} nu este configurată pe server.` });
      }
      if (reason === 'schimb' && !SCHIMB_COURIERS.includes(courier)) {
        return sendJSON(res, 400, { error: `Coletul la schimb nu se poate emite prin ${courierLabel} — momentan doar prin Sameday.` });
      }

      // adresa: folosim ce vine explicit in cerere; daca lipseste cate un
      // camp, completam din comanda asociata tichetului (daca exista)
      let linkedOrder = null;
      if (ticket.relatedOrderId) linkedOrder = db.getOrder(currentAgent.companyId, ticket.relatedOrderId);

      const address = body.address || linkedOrder?.shippingAddress || '';
      const city = body.city || linkedOrder?.shippingCity || '';
      const postalCode = body.postalCode || linkedOrder?.shippingPostalCode || '';
      const phone = body.phone || linkedOrder?.shippingPhone || '';
      const customerName = body.customerName || linkedOrder?.shippingName || ticket.requesterName;
      const email = body.email || linkedOrder?.customerEmail || ticket.requesterEmail || '';

      if (!address || !city || !postalCode || !phone) {
        return sendJSON(res, 400, { error: 'Adresă/telefon incomplete pentru ridicare — completează-le în formular.' });
      }

      try {
        // Colet la Schimb, la GLS, foloseste serviciul dedicat Exchange (XS)
        // -- o singura cerere produce ambele AWB-uri (Tur + Retur) deodata,
        // testat live cu contul real. Sameday face asta nativ, deja, prin
        // propriul lor serviciu SWAP (fara nicio schimbare necesara aici)
        const result = (reason === 'schimb' && courier === 'gls')
          ? await gls.createExchangeAwb(company, { ticketId: ticket.id, customerName, address, city, postalCode, phone, email })
          : await courierClient.createPickupAwb(company, { ticketId: ticket.id, reason, customerName, address, city, postalCode, phone, email });
        const updated = db.setTicketPickupAwb(currentAgent.companyId, ticket.id, {
          awbNumber: result.trackingNumber,
          parcelId: result.parcelId,
          labelPdf: result.labelPdf ? result.labelPdf.toString('base64') : null,
          section: reason,
          pickupAddress: address,
          pickupCity: city,
          pickupPostalCode: postalCode,
          pickupPhone: phone,
          courier,
          secondaryAwbNumber: result.secondaryAwbNumber,
        }, currentAgent);
        return sendJSON(res, 200, { ...updated, labelAvailable: Boolean(result.labelPdf) });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const cancelPickupMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/cancel-pickup-awb$/);
    if (cancelPickupMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, cancelPickupMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!ticket.pickupAwbParcelId) return sendJSON(res, 400, { error: 'Tichetul nu are AWB de ridicare generat.' });
      try {
        const cancelCourier = COURIER_MODULES[ticket.pickupAwbCourier] || gls;
        let warning = null;
        if (cancelCourier === sameday) {
          await sameday.deleteAwb(company, ticket.pickupAwbParcelId);
        } else if (cancelCourier === gls) {
          await gls.deleteParcel(company, ticket.pickupAwbParcelId);
        } else {
          // PTT Express nu ofera anulare prin API (confirmat live) --
          // eliberam doar tichetul local, ca sa poata fi reemis cu alt
          // curier; AWB-ul ramane activ la PTT, de anulat manual acolo
          warning = 'AWB-ul rămâne activ în contul PTT Express — anulează-l manual, din panoul lor web, ca să nu rămână o expediere fantomă.';
        }
        const updated = db.clearTicketPickupAwb(currentAgent.companyId, ticket.id, currentAgent);
        return sendJSON(res, 200, { ...updated, warning });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const reissuePickupMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/reissue-pickup-awb$/);
    if (reissuePickupMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, reissuePickupMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!['service', 'retur'].includes(ticket.section)) {
        return sendJSON(res, 400, { error: 'Reemiterea AWB este disponibilă doar pentru tichetele Service și Retur.' });
      }
      if (!ticket.pickupAwbParcelId) return sendJSON(res, 400, { error: 'Tichetul nu are un AWB de ridicare de reemis.' });

      const courier = ['sameday', 'ptt'].includes(ticket.pickupAwbCourier) ? ticket.pickupAwbCourier : 'gls';
      const courierClient = COURIER_MODULES[courier];
      if (NO_REISSUE_COURIERS.includes(courier)) {
        return sendJSON(res, 400, { error: 'PTT Express nu permite anularea AWB-ului prin API, deci reemiterea nu e disponibilă. Elimină AWB-ul de pe tichet, anulează-l manual în panoul PTT și generează unul nou.' });
      }

      // pas 1: anulam AWB-ul vechi (colet neridicat -- client negasit,
      // curier neprezentat etc.), apoi curatam IMEDIAT starea tichetului --
      // altfel, daca pasul 2 (generare) esueaza, tichetul ar ramane cu un
      // AWB "activ" in interfata, desi de fapt a fost deja anulat la curier
      // PTT Express nu expune nicio operatie de anulare in API (verificat pe
      // serviciul lor live) -- pentru ei sarim peste pasul de anulare, altfel
      // reemiterea ar esua mereu; AWB-ul vechi ramane activ la PTT si trebuie
      // anulat manual, iar utilizatorul e avertizat explicit in raspuns
      const oldAwbNumber = ticket.pickupAwbNumber;
      let reissueWarning = null;
      try {
        if (courier === 'sameday') {
          await sameday.deleteAwb(company, ticket.pickupAwbParcelId);
        } else if (courier === 'gls') {
          await gls.deleteParcel(company, ticket.pickupAwbParcelId);
        } else {
          reissueWarning = `AWB-ul vechi (${oldAwbNumber}) rămâne activ în contul PTT Express — anulează-l manual, din panoul lor web, ca să nu rămână o expediere fantomă.`;
        }
        db.clearTicketPickupAwb(currentAgent.companyId, ticket.id, currentAgent);
      } catch (e) {
        return sendJSON(res, 502, { error: `Nu am putut anula AWB-ul vechi: ${e.message}` });
      }

      // pas 2: generam un AWB nou, cu exact aceleasi date de ridicare
      // folosite prima data (deja salvate pe tichet)
      const reason = ['retur', 'schimb'].includes(ticket.section) ? ticket.section : 'service';
      const address = ticket.pickupAddress || '';
      const city = ticket.pickupCity || '';
      const postalCode = ticket.pickupPostalCode || '';
      const phone = ticket.pickupPhone || '';
      const customerName = ticket.requesterName;
      const email = ticket.requesterEmail || '';

      if (!address || !city || !postalCode || !phone) {
        const incompleteWarning = reissueWarning
          ? `${reissueWarning} Datele de ridicare sunt incomplete pentru a genera automat unul nou — completează manual formularul.`
          : 'AWB-ul vechi a fost anulat, dar datele de ridicare sunt incomplete pentru a genera automat unul nou -- completează manual formularul.';
        return sendJSON(res, 200, { ...db.getTicket(currentAgent.companyId, ticket.id), reissued: false, warning: incompleteWarning });
      }

      try {
        const result = await courierClient.createPickupAwb(company, {
          ticketId: ticket.id, reason, customerName, address, city, postalCode, phone, email,
        });
        const updated = db.setTicketPickupAwb(currentAgent.companyId, ticket.id, {
          awbNumber: result.trackingNumber,
          parcelId: result.parcelId,
          labelPdf: result.labelPdf ? result.labelPdf.toString('base64') : null,
          section: reason,
          pickupAddress: address,
          pickupCity: city,
          pickupPostalCode: postalCode,
          pickupPhone: phone,
          courier,
          secondaryAwbNumber: result.secondaryAwbNumber,
        }, currentAgent);
        return sendJSON(res, 200, { ...updated, labelAvailable: Boolean(result.labelPdf), reissued: true, warning: reissueWarning });
      } catch (e) {
        return sendJSON(res, 502, { error: `AWB-ul vechi a fost anulat, dar generarea celui nou a eșuat: ${e.message}. Generează manual unul nou, din formular.` });
      }
    }

    const pickupLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/pickup-awb-label$/);
    if (pickupLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(currentAgent.companyId, pickupLabelMatch[1]);
      if (!ticket || !ticket.pickupAwbParcelId) return sendJSON(res, 404, { error: 'Nu există AWB de ridicare pentru acest tichet.' });

      if (ticket.pickupAwbLabelPdf) {
        return sendLabelFile(res, Buffer.from(ticket.pickupAwbLabelPdf, 'base64'), `ridicare-${ticket.pickupAwbNumber}`);
      }

      try {
        const activeCourier = COURIER_MODULES[ticket.pickupAwbCourier] || gls;
        const pdfBuffer = activeCourier === sameday
          ? await sameday.getAwbPdf(company, ticket.pickupAwbParcelId)
          : await activeCourier.getLabelPdf(company, ticket.pickupAwbParcelId);
        db.setTicketPickupAwb(currentAgent.companyId, ticket.id, {
          awbNumber: ticket.pickupAwbNumber,
          parcelId: ticket.pickupAwbParcelId,
          labelPdf: pdfBuffer.toString('base64'),
          section: ticket.section,
          courier: ticket.pickupAwbCourier,
        }, currentAgent);
        return sendLabelFile(res, pdfBuffer, `ridicare-${ticket.pickupAwbNumber}`);
      } catch (e) {
        return sendJSON(res, 502, {
          error: `Eticheta nu e salvată local, iar re-cererea ei de la curier a eșuat (${e.message}). Anulează acest AWB de ridicare și generează unul nou.`,
        });
      }
    }

    // ---- AWB de retur (service -> client, dupa reparatie) ----

    const generateReturnMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/generate-return-awb$/);
    if (generateReturnMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, generateReturnMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (ticket.section !== 'service') return sendJSON(res, 400, { error: 'AWB-ul de retur e disponibil doar pentru tichetele de Service.' });
      if (!ticket.pickupAddress || !ticket.pickupCity || !ticket.pickupPostalCode || !ticket.pickupPhone) {
        return sendJSON(res, 400, { error: 'Lipsesc datele de adresă ale clientului — nu pot genera AWB-ul de retur.' });
      }

      const body = await readBody(req);
      const courier = ['sameday', 'ptt'].includes(body.courier) ? body.courier : 'gls';
      const courierClients = { sameday, ptt: pttexpress, gls };
      const courierLabels = { sameday: 'Sameday', ptt: 'PTT Express', gls: 'GLS' };
      if (!courierClients[courier].isConfigured(company)) {
        return sendJSON(res, 400, { error: `Integrarea ${courierLabels[courier]} nu este configurată pe server.` });
      }

      try {
        const result = courier === 'gls'
          ? await gls.createParcel(company, {
              mpId: `${ticket.id}-RETUR`,
              codAmount: 0,
              currency: 'RON',
              shippingName: ticket.requesterName,
              shippingAddress: ticket.pickupAddress,
              shippingPostalCode: ticket.pickupPostalCode,
              shippingCity: ticket.pickupCity,
              shippingPhone: ticket.pickupPhone,
              customerEmail: ticket.requesterEmail,
            })
          : await courierClients[courier].createForwardAwb(company, {
              mpId: `${ticket.id}-RETUR`,
              codAmount: 0,
              shippingName: ticket.requesterName,
              shippingAddress: ticket.pickupAddress,
              shippingPostalCode: ticket.pickupPostalCode,
              shippingCity: ticket.pickupCity,
              shippingPhone: ticket.pickupPhone,
              customerEmail: ticket.requesterEmail,
            });
        const updated = db.setTicketReturnAwb(currentAgent.companyId, ticket.id, {
          awbNumber: result.trackingNumber,
          parcelId: result.parcelId,
          labelPdf: result.labelPdf ? result.labelPdf.toString('base64') : null,
          courier,
        }, currentAgent);
        return sendJSON(res, 200, { ...updated, labelAvailable: Boolean(result.labelPdf) });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const cancelReturnMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/cancel-return-awb$/);
    if (cancelReturnMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, cancelReturnMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!ticket.returnAwbParcelId) return sendJSON(res, 400, { error: 'Tichetul nu are AWB de retur generat.' });
      try {
        const cancelReturnCourier = COURIER_MODULES[ticket.returnAwbCourier] || gls;
        let warning = null;
        if (cancelReturnCourier === sameday) {
          await sameday.deleteAwb(company, ticket.returnAwbParcelId);
        } else if (cancelReturnCourier === gls) {
          await gls.deleteParcel(company, ticket.returnAwbParcelId);
        } else {
          warning = 'AWB-ul rămâne activ în contul PTT Express — anulează-l manual, din panoul lor web, ca să nu rămână o expediere fantomă.';
        }
        const updated = db.clearTicketReturnAwb(currentAgent.companyId, ticket.id, currentAgent);
        return sendJSON(res, 200, { ...updated, warning });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const returnLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/return-awb-label$/);
    if (returnLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(currentAgent.companyId, returnLabelMatch[1]);
      if (!ticket || !ticket.returnAwbParcelId) return sendJSON(res, 404, { error: 'Nu există AWB de retur pentru acest tichet.' });

      if (ticket.returnAwbLabelPdf) {
        return sendLabelFile(res, Buffer.from(ticket.returnAwbLabelPdf, 'base64'), `retur-${ticket.returnAwbNumber}`);
      }
      try {
        const activeCourier = COURIER_MODULES[ticket.returnAwbCourier] || gls;
        const pdfBuffer = activeCourier === sameday
          ? await sameday.getAwbPdf(company, ticket.returnAwbParcelId)
          : await activeCourier.getLabelPdf(company, ticket.returnAwbParcelId);
        db.setTicketReturnAwb(currentAgent.companyId, ticket.id, {
          awbNumber: ticket.returnAwbNumber,
          parcelId: ticket.returnAwbParcelId,
          labelPdf: pdfBuffer.toString('base64'),
          courier: ticket.returnAwbCourier,
        }, currentAgent);
        return sendLabelFile(res, pdfBuffer, `retur-${ticket.returnAwbNumber}`);
      } catch (e) {
        return sendJSON(res, 502, {
          error: `Eticheta nu e salvată local, iar re-cererea ei de la curier a eșuat (${e.message}). Anulează AWB-ul de retur și generează unul nou.`,
        });
      }
    }

    // ---- actualizare manuala status (etapa) + istoric tracking ----

    const refreshStageMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refresh-awb-status$/);
    if (refreshStageMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, refreshStageMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });

      // alegem AWB-ul activ (ridicare sau retur) dupa etapa curenta
      const isReturnLeg = ['return_awb_issued', 'in_transit_to_client', 'delivered_to_client'].includes(ticket.stage);
      const trackingNumber = isReturnLeg ? ticket.returnAwbNumber : ticket.pickupAwbNumber;
      const activeCourier = COURIER_MODULES[isReturnLeg ? ticket.returnAwbCourier : ticket.pickupAwbCourier] || gls;
      if (!trackingNumber) return sendJSON(res, 400, { error: 'Tichetul nu are niciun AWB activ de urmărit.' });

      try {
        const statuses = activeCourier === gls ? await gls.getParcelStatus(company, trackingNumber) : await activeCourier.getAwbStatus(company, trackingNumber);
        const delivered = statuses.some((s) => /livrat|delivered|predat destinatar|handed over/i.test(s.StatusDescription || ''));
        const pickedUp = statuses.some((s) => /preluat|ridicat|colectat|picked ?up|pickup|a p[ăa]r[ăa]sit/i.test(s.StatusDescription || ''));

        let newStage = ticket.stage;
        if (ticket.stage === 'pickup_awb_issued') {
          if (delivered) newStage = 'at_service'; // caz rar: ridicat si livrat intre doua verificari
          else if (pickedUp) newStage = 'in_transit_to_service';
        } else if (ticket.stage === 'in_transit_to_service') {
          if (delivered) newStage = 'at_service';
        } else if (ticket.stage === 'return_awb_issued') {
          if (delivered) newStage = 'delivered_to_client';
          else if (pickedUp) newStage = 'in_transit_to_client';
        } else if (ticket.stage === 'in_transit_to_client') {
          if (delivered) newStage = 'delivered_to_client';
        }

        const updated = db.updateTicketStage(currentAgent.companyId, ticket.id, newStage, currentAgent);
        return sendJSON(res, 200, { ...updated, trackingEventsCount: statuses.length });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const setStageMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/set-stage$/);
    if (setStageMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, setStageMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const body = await readBody(req);
      const ALLOWED_MANUAL_STAGES = ['pickup_awb_issued', 'at_service', 'delivered_to_client'];
      if (!ALLOWED_MANUAL_STAGES.includes(body.stage)) {
        return sendJSON(res, 400, { error: 'Etapă invalidă.' });
      }
      const updated = db.updateTicketStage(currentAgent.companyId, ticket.id, body.stage, currentAgent);
      return sendJSON(res, 200, updated);
    }

    const refreshSecondaryMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refresh-secondary-status$/);
    if (refreshSecondaryMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, refreshSecondaryMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!ticket.pickupAwbSecondaryNumber) return sendJSON(res, 400, { error: 'Tichetul nu are AWB secundar (retur).' });
      try {
        const secondaryCourier = COURIER_MODULES[ticket.pickupAwbCourier] || gls;
        const statuses = secondaryCourier === gls
          ? await gls.getParcelStatus(company, ticket.pickupAwbSecondaryNumber)
          : await secondaryCourier.getAwbStatus(company, ticket.pickupAwbSecondaryNumber);
        const delivered = statuses.some((s) => /livrat|delivered|predat destinatar|handed over/i.test(s.StatusDescription || ''));
        const pickedUp = statuses.some((s) => /preluat|ridicat|colectat|picked ?up|pickup|a p[ăa]r[ăa]sit/i.test(s.StatusDescription || ''));

        let newStage = ticket.pickupAwbSecondaryStage || 'awb_issued';
        if (newStage === 'awb_issued') {
          if (delivered) newStage = 'delivered';
          else if (pickedUp) newStage = 'picked_up';
        } else if (newStage === 'picked_up') {
          if (delivered) newStage = 'delivered';
        }

        const updated = db.updateTicketPickupSecondaryStage(currentAgent.companyId, ticket.id, newStage, currentAgent);
        return sendJSON(res, 200, { ...updated, trackingEventsCount: statuses.length });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const trackingMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/awb-tracking$/);
    if (trackingMatch && req.method === 'GET') {
      const ticket = db.getTicket(currentAgent.companyId, trackingMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const leg = ['return', 'secondary'].includes(query.leg) ? query.leg : 'pickup';
      const trackingNumber = leg === 'return' ? ticket.returnAwbNumber : (leg === 'secondary' ? ticket.pickupAwbSecondaryNumber : ticket.pickupAwbNumber);
      // AWB-ul secundar (Colet la Schimb) e generat mereu de acelasi curier ca cel principal (doar Sameday are acest mecanism)
      const legCourierRaw = leg === 'return' ? ticket.returnAwbCourier : ticket.pickupAwbCourier;
      const legCourier = COURIER_MODULES[legCourierRaw] || gls;
      if (!trackingNumber) return sendJSON(res, 404, { error: 'Nu există AWB pentru acest segment.' });
      try {
        const statuses = legCourier === gls
          ? await gls.getParcelStatus(company, trackingNumber)
          : await legCourier.getAwbStatus(company, trackingNumber);
        return sendJSON(res, 200, statuses);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const orderTrackingMatch = pathname.match(/^\/api\/orders\/([^/]+)\/awb-tracking$/);
    if (orderTrackingMatch && req.method === 'GET') {
      const order = db.getOrder(currentAgent.companyId, orderTrackingMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      if (!order.shippingAwb) return sendJSON(res, 404, { error: 'Comanda nu are AWB.' });
      // Curierul se determina, in ordine, din: numele curierului sincronizat
      // de la MerchantPro (carrierTrackingName), curierul cu care am emis noi
      // AWB-ul (awbCourier) si -- daca ambele lipsesc -- prin incercarea
      // curierilor configurati pe companie. Ultimul caz e cel real pentru
      // AWB-urile PTT Express: MerchantPro nu trimite deloc obiectul
      // carrier_tracking pentru ele, asa ca numele curierului e gol.
      // Comanda nu are un ID intern de colet (parcelId), doar numarul AWB,
      // dar toate cele trei functii de status accepta direct numarul AWB.
      const courierName = `${order.carrierTrackingName || ''} ${order.awbCourier || ''}`.toLowerCase();
      let candidates;
      if (courierName.includes('gls')) candidates = ['gls'];
      else if (courierName.includes('sameday')) candidates = ['sameday'];
      else if (courierName.includes('ptt')) candidates = ['ptt'];
      else candidates = ['ptt', 'sameday', 'gls'].filter((key) => COURIER_MODULES[key].isConfigured(company));

      if (!candidates.length) {
        return sendJSON(res, 400, { error: 'Urmărirea directă în aplicație nu este disponibilă pentru acest curier.' });
      }

      let lastError = null;
      for (const key of candidates) {
        try {
          const statuses = key === 'gls'
            ? await gls.getParcelStatus(company, order.shippingAwb)
            : await COURIER_MODULES[key].getAwbStatus(company, order.shippingAwb);
          // cu un singur candidat returnam si lista goala (AWB fara evenimente
          // inca); cand ghicim curierul, o lista goala inseamna, de fapt, "nu e
          // al lui" -- trecem la urmatorul si returnam gol doar daca niciunul nu stie de el
          if (statuses.length || candidates.length === 1) return sendJSON(res, 200, statuses);
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError) return sendJSON(res, 502, { error: lastError.message });
      // am incercat mai multi curieri si niciunul nu stie de AWB-ul asta
      return sendJSON(res, 400, { error: 'Urmărirea directă în aplicație nu este disponibilă pentru acest curier.' });
    }

    // ---- profil client (agregat din comenzi + tichete cu acelasi telefon/email) ----

    if (pathname === '/api/clients/lookup' && req.method === 'GET') {
      const profile = db.getClientProfile(currentAgent.companyId, { phone: query.phone || undefined, email: query.email || undefined, minDateCreated: orderCutoff });
      return sendJSON(res, 200, profile);
    }

    // ---- fotografii tichet (max 6, incarcate ca base64 in JSON) ----

    const photosListMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/photos$/);
    if (photosListMatch && req.method === 'GET') {
      return sendJSON(res, 200, db.listTicketPhotos(currentAgent.companyId, photosListMatch[1]));
    }
    if (photosListMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, photosListMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const body = await readBody(req, 30_000_000); // pana la ~30MB (fotografii comprimate pe client)
      if (!body.dataBase64 || !body.mimeType) return sendJSON(res, 400, { error: 'Lipsesc dataBase64 sau mimeType.' });
      if (!/^image\/(jpeg|png|webp)$/.test(body.mimeType)) return sendJSON(res, 400, { error: 'Tip de fișier neacceptat — doar JPEG, PNG sau WEBP.' });
      try {
        const photo = db.addTicketPhoto(currentAgent.companyId, ticket.id, { dataBase64: body.dataBase64, mimeType: body.mimeType });
        return sendJSON(res, 200, photo);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    const photoServeMatch = pathname.match(/^\/api\/tickets\/photos\/([^/]+)$/);
    if (photoServeMatch && req.method === 'GET') {
      const photo = db.getTicketPhoto(currentAgent.companyId, photoServeMatch[1]);
      if (!photo) return sendJSON(res, 404, { error: 'Fotografie negăsită' });
      const buffer = Buffer.from(photo.dataBase64, 'base64');
      res.writeHead(200, { 'Content-Type': photo.mimeType, 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(buffer);
    }
    if (photoServeMatch && req.method === 'DELETE') {
      const ok = db.deleteTicketPhoto(currentAgent.companyId, photoServeMatch[1]);
      if (!ok) return sendJSON(res, 404, { error: 'Fotografie negăsită' });
      return sendJSON(res, 200, { ok: true });
    }

    // ---- date bancare rambursare (Retur) + eticheta rambursare (PDF / CSV) ----

    const refundInfoMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refund-info$/);
    if (refundInfoMatch && req.method === 'PATCH') {
      const ticket = db.getTicket(currentAgent.companyId, refundInfoMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const body = await readBody(req);
      if (!body.iban || !String(body.iban).trim()) return sendJSON(res, 400, { error: 'IBAN-ul este obligatoriu.' });
      if (body.amount == null || Number.isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
        return sendJSON(res, 400, { error: 'Suma de returnat trebuie să fie un număr pozitiv.' });
      }
      const updated = db.setTicketRefundInfo(currentAgent.companyId, ticket.id, {
        iban: String(body.iban).trim().toUpperCase().replace(/\s+/g, ''),
        accountHolder: body.accountHolder || null,
        amount: body.amount,
        reason: body.reason || null,
      }, currentAgent);
      return sendJSON(res, 200, updated);
    }

    const clearRefundInfoMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refund-info$/);
    if (clearRefundInfoMatch && req.method === 'DELETE') {
      const ticket = db.getTicket(currentAgent.companyId, clearRefundInfoMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const updated = db.clearTicketRefundInfo(currentAgent.companyId, ticket.id, currentAgent);
      return sendJSON(res, 200, updated);
    }

    const markRefundPaidMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/mark-refund-paid$/);
    if (markRefundPaidMatch && req.method === 'POST') {
      const ticket = db.getTicket(currentAgent.companyId, markRefundPaidMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const updated = db.markTicketRefundPaid(currentAgent.companyId, ticket.id, currentAgent);
      return sendJSON(res, 200, updated);
    }

    if (pathname === '/api/tickets/mark-refund-paid-bulk' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.ticketIds) || !body.ticketIds.length) {
        return sendJSON(res, 400, { error: 'Lipsesc id-urile tichetelor.' });
      }
      const result = db.markTicketsRefundPaidBulk(currentAgent.companyId, body.ticketIds, currentAgent);
      return sendJSON(res, 200, result);
    }

    const refundLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refund-label\.(pdf|csv)$/);
    if (refundLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(currentAgent.companyId, refundLabelMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!ticket.refundIban || ticket.refundAmount == null) {
        return sendJSON(res, 400, { error: 'Completează mai întâi datele bancare și suma de returnat.' });
      }
      let linkedOrder = null;
      if (ticket.relatedOrderId) linkedOrder = db.getOrder(currentAgent.companyId, ticket.relatedOrderId);
      const fileFormat = refundLabelMatch[2];

      const fields = [
        ['Cod tichet', ticket.sectionCode || ticket.id],
        ['Comandă asociată', linkedOrder ? `#${linkedOrder.mpId}` : '—'],
        ['Client', ticket.requesterName],
        ['Telefon', ticket.requesterPhone || ticket.pickupPhone || '—'],
        ['IBAN', ticket.refundIban],
        ['Titular cont', ticket.refundAccountHolder || ticket.requesterName],
        ['Sumă de returnat', `${Number(ticket.refundAmount).toFixed(2)} RON`],
        ['Motiv retur', ticket.refundReason || ticket.description || '—'],
        ['Data generare', new Date().toLocaleString('ro-RO')],
      ];

      if (fileFormat === 'pdf') {
        const buffer = pdf.generateSimplePdf({
          title: `Etichetă rambursare — ${ticket.sectionCode || ticket.id}`,
          subtitle: `Generat la ${new Date().toLocaleString('ro-RO')}`,
          lines: fields.map(([k, v]) => `${k}: ${v}`),
        });
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="rambursare-${ticket.sectionCode || ticket.id}.pdf"`,
          'Content-Length': buffer.length,
        });
        return res.end(buffer);
      }

      // CSV -- se deschide direct in Excel; BOM pentru diacritice corecte
      const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const csv = '\uFEFF' + fields.map(([k, v]) => `${esc(k)},${esc(v)}`).join('\r\n');
      const buffer = Buffer.from(csv, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rambursare-${ticket.sectionCode || ticket.id}.csv"`,
        'Content-Length': buffer.length,
      });
      return res.end(buffer);
    }

    // ---- clienti importati (Excel) ----

    return sendJSON(res, 404, { error: 'Rută necunoscută' });
  } catch (e) {
    return sendJSON(res, 500, { error: e.message || 'Eroare internă' });
  }
}

const server = http.createServer((req, res) => {
  // antete de securitate, aplicate la fiecare raspuns -- vezi ce resurse
  // externe chiar foloseste aplicatia (fonturi Google, biblioteca XLSX de pe
  // cdnjs), ca sa nu blocam din greseala ceva ce functioneaza deja
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // 'unsafe-inline' necesar -- interfata foloseste stiluri inline extensiv
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:", // https: larg -- imaginile produselor vin de pe domeniul magazinului fiecarei companii, diferit de la una la alta
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.query);
  } else {
    serveStatic(req, res, pathname);
  }
});

server.listen(PORT, () => {
  console.log(`Ticket support app rulează pe http://localhost:${PORT}`);
  const syncIntervalMs = Number(process.env.MERCHANTPRO_SYNC_INTERVAL_MS || 2 * 60 * 1000);
  orderSync.startBackgroundSync(syncIntervalMs);

  // Completeaza indexul de cautare al comenzilor pentru randurile salvate
  // inainte ca el sa existe. Ruleaza in loturi mici, cu pauza intre ele:
  // node:sqlite e sincron, deci un lot mare ar tine serverul blocat.
  (function completeazaIndexulDeCautare() {
    let total = 0;
    const pas = () => {
      let procesate = 0;
      try {
        procesate = db.backfillOrderSearchIndex(1000);
      } catch (e) {
        console.error('Indexare comenzi pentru căutare — eroare:', e.message);
        return;
      }
      total += procesate;
      if (procesate > 0) {
        setTimeout(pas, 250);
      } else if (total > 0) {
        console.log(`Index de căutare completat pentru ${total} comenzi existente.`);
      }
    };
    setTimeout(pas, 5000); // lasam serverul sa porneasca linistit
  }());
  // NOTA: job-ul de polling (samedayTrackingPoller) nu mai e necesar --
  // am descoperit si confirmat live un endpoint real, per-AWB
  // (GET /api/client/parcel/{awb}/status-history), care ofera istoric
  // complet direct, fara nicio acumulare. Codul ramane neutilizat, in
  // lib/sameday-tracking-poller.js.
  // curatare periodica a etichetelor AWB vechi (peste 30 de zile) -- pastram
  // doar numarul AWB, nu si PDF-ul greu; ruleaza o data la pornire, apoi o
  // data pe zi. Daca cineva mai are nevoie de o eticheta veche, se re-cere
  // live de la curier (fallback deja existent in rutele de mai sus).
  const AWB_LABEL_RETENTION_DAYS = 30;
  function runAwbLabelCleanup() {
    try {
      const result = db.purgeOldAwbLabels(AWB_LABEL_RETENTION_DAYS);
      const total = result.orders + result.ticketsPickup + result.ticketsReturn;
      if (total > 0) console.log(`Curățare etichete AWB vechi (>${AWB_LABEL_RETENTION_DAYS} zile): ${total} șterse (${result.orders} comenzi, ${result.ticketsPickup} ridicări, ${result.ticketsReturn} retururi).`);
    } catch (e) {
      console.error('Eroare la curățarea etichetelor AWB vechi:', e.message);
    }
  }
  runAwbLabelCleanup();
  setInterval(runAwbLabelCleanup, 24 * 60 * 60 * 1000);

  // backup complet, garantat corect, al bazei de date -- o data la pornire,
  // apoi la fiecare 6 ore (limiteaza fereastra maxima de pierdere posibila,
  // in caz de coruptie reala a bazei de date, la 6 ore, nu 24). Pastreaza
  // ultimele 28 de fisiere (4/zi x 7 zile = o saptamana de istoric).
  function runFrequentBackup() {
    try {
      const backupPath = db.createBackup(28);
      console.log(`Backup creat: ${backupPath}`);
    } catch (e) {
      console.error('Eroare la crearea backup-ului:', e.message);
    }
  }
  runFrequentBackup();
  setInterval(runFrequentBackup, 6 * 60 * 60 * 1000);
});
