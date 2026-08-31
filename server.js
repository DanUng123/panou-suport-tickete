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
const gls = require('./lib/gls');
const sameday = require('./lib/sameday');
const mp = require('./lib/merchantpro');
const gomag = require('./lib/gomag');
const pdf = require('./lib/pdf');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- sesiuni simple in memorie (token -> {agentId, expiresAt}) ----------
// Notă: pentru producție la scară mare, folosiți sesiuni persistente / JWT / SSO.
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ore

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
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
      return sendJSON(res, 200, db.getAllPlatformClients({ page, pageSize, q: query.q || '' }));
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
    // datele companiei (inclusiv credentialele decriptate GLS/Sameday/MerchantPro) --
    // preluate o singura data, disponibile pentru toate rutele de mai jos
    const company = db.getCompany(currentAgent.companyId);

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
      const { merchantProApiSecret, glsPassword, samedayPassword, gomagApiKey, ...rest } = company;
      return sendJSON(res, 200, {
        ...rest,
        merchantProApiSecretSet: Boolean(merchantProApiSecret),
        glsPasswordSet: Boolean(glsPassword),
        samedayPasswordSet: Boolean(samedayPassword),
        gomagApiKeySet: Boolean(gomagApiKey),
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
      const updated = db.updateCompanyCredentials(currentAgent.companyId, patch);
      const { merchantProApiSecret, glsPassword, samedayPassword, gomagApiKey, ...rest } = updated;
      return sendJSON(res, 200, {
        ...rest,
        merchantProApiSecretSet: Boolean(merchantProApiSecret),
        glsPasswordSet: Boolean(glsPassword),
        samedayPasswordSet: Boolean(samedayPassword),
        gomagApiKeySet: Boolean(gomagApiKey),
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

    if (pathname === '/api/orders/stats' && req.method === 'GET') {
      return sendJSON(res, 200, db.getOrderStats(currentAgent.companyId, { dateFrom: query.dateFrom || undefined, dateTo: query.dateTo || undefined }));
    }

    if (pathname === '/api/product-analytics' && req.method === 'GET') {
      return sendJSON(res, 200, db.getProductAnalytics(currentAgent.companyId, { dateFrom: query.dateFrom || undefined, dateTo: query.dateTo || undefined }));
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
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
      };
      return sendJSON(res, 200, db.listOrders(currentAgent.companyId, filters));
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
      const courier = body.courier === 'sameday' ? 'sameday' : 'gls';
      const courierClient = courier === 'sameday' ? sameday : gls;

      if (!courierClient.isConfigured(company)) {
        return sendJSON(res, 400, { error: `Integrarea ${courier === 'sameday' ? 'Sameday' : 'GLS'} nu este configurată pe server.` });
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
        if (ticket.pickupAwbCourier === 'sameday') {
          await sameday.deleteAwb(company, ticket.pickupAwbParcelId);
        } else {
          await gls.deleteParcel(company, ticket.pickupAwbParcelId);
        }
        const updated = db.clearTicketPickupAwb(currentAgent.companyId, ticket.id, currentAgent);
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const pickupLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/pickup-awb-label$/);
    if (pickupLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(currentAgent.companyId, pickupLabelMatch[1]);
      if (!ticket || !ticket.pickupAwbParcelId) return sendJSON(res, 404, { error: 'Nu există AWB de ridicare pentru acest tichet.' });

      if (ticket.pickupAwbLabelPdf) {
        const pdfBuffer = Buffer.from(ticket.pickupAwbLabelPdf, 'base64');
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="ridicare-${ticket.pickupAwbNumber}.pdf"`,
          'Content-Length': pdfBuffer.length,
        });
        return res.end(pdfBuffer);
      }

      try {
        const activeCourier = ticket.pickupAwbCourier === 'sameday' ? sameday : gls;
        const pdfBuffer = activeCourier === sameday
          ? await sameday.getAwbPdf(company, ticket.pickupAwbParcelId)
          : await gls.getLabelPdf(company, ticket.pickupAwbParcelId);
        db.setTicketPickupAwb(currentAgent.companyId, ticket.id, {
          awbNumber: ticket.pickupAwbNumber,
          parcelId: ticket.pickupAwbParcelId,
          labelPdf: pdfBuffer.toString('base64'),
          section: ticket.section,
          courier: ticket.pickupAwbCourier,
        }, currentAgent);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="ridicare-${ticket.pickupAwbNumber}.pdf"`,
          'Content-Length': pdfBuffer.length,
        });
        return res.end(pdfBuffer);
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
      const courier = body.courier === 'sameday' ? 'sameday' : 'gls';
      if (courier === 'sameday' && !sameday.isConfigured(company)) {
        return sendJSON(res, 400, { error: 'Integrarea Sameday nu este configurată pe server.' });
      }
      if (courier === 'gls' && !gls.isConfigured(company)) {
        return sendJSON(res, 400, { error: 'Integrarea GLS nu este configurată pe server.' });
      }

      try {
        const result = courier === 'sameday'
          ? await sameday.createForwardAwb(company, {
              mpId: `${ticket.id}-RETUR`,
              codAmount: 0,
              shippingName: ticket.requesterName,
              shippingAddress: ticket.pickupAddress,
              shippingPostalCode: ticket.pickupPostalCode,
              shippingCity: ticket.pickupCity,
              shippingPhone: ticket.pickupPhone,
            })
          : await gls.createParcel(company, {
              mpId: `${ticket.id}-RETUR`,
              codAmount: 0,
              currency: 'RON',
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
        if (ticket.returnAwbCourier === 'sameday') {
          await sameday.deleteAwb(company, ticket.returnAwbParcelId);
        } else {
          await gls.deleteParcel(company, ticket.returnAwbParcelId);
        }
        const updated = db.clearTicketReturnAwb(currentAgent.companyId, ticket.id, currentAgent);
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const returnLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/return-awb-label$/);
    if (returnLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(currentAgent.companyId, returnLabelMatch[1]);
      if (!ticket || !ticket.returnAwbParcelId) return sendJSON(res, 404, { error: 'Nu există AWB de retur pentru acest tichet.' });

      if (ticket.returnAwbLabelPdf) {
        const pdfBuffer = Buffer.from(ticket.returnAwbLabelPdf, 'base64');
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="retur-${ticket.returnAwbNumber}.pdf"`,
          'Content-Length': pdfBuffer.length,
        });
        return res.end(pdfBuffer);
      }
      try {
        const activeCourier = ticket.returnAwbCourier === 'sameday' ? sameday : gls;
        const pdfBuffer = activeCourier === sameday
          ? await sameday.getAwbPdf(company, ticket.returnAwbParcelId)
          : await gls.getLabelPdf(company, ticket.returnAwbParcelId);
        db.setTicketReturnAwb(currentAgent.companyId, ticket.id, {
          awbNumber: ticket.returnAwbNumber,
          parcelId: ticket.returnAwbParcelId,
          labelPdf: pdfBuffer.toString('base64'),
          courier: ticket.returnAwbCourier,
        }, currentAgent);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="retur-${ticket.returnAwbNumber}.pdf"`,
          'Content-Length': pdfBuffer.length,
        });
        return res.end(pdfBuffer);
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
      const activeCourier = (isReturnLeg ? ticket.returnAwbCourier : ticket.pickupAwbCourier) === 'sameday' ? sameday : gls;
      if (!trackingNumber) return sendJSON(res, 400, { error: 'Tichetul nu are niciun AWB activ de urmărit.' });

      try {
        const statuses = activeCourier === sameday ? await sameday.getAwbStatus(company, trackingNumber) : await gls.getParcelStatus(company, trackingNumber);
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
      // AWB-ul secundar exista doar la Sameday (Colet la Schimb)
      try {
        const statuses = await sameday.getAwbStatus(company, ticket.pickupAwbSecondaryNumber);
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
      const legCourier = legCourierRaw === 'sameday' ? sameday : gls;
      if (!trackingNumber) return sendJSON(res, 404, { error: 'Nu există AWB pentru acest segment.' });
      try {
        const statuses = legCourier === sameday ? await sameday.getAwbStatus(company, trackingNumber) : await gls.getParcelStatus(company, trackingNumber);
        return sendJSON(res, 200, statuses);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    // ---- profil client (agregat din comenzi + tichete cu acelasi telefon/email) ----

    if (pathname === '/api/clients/lookup' && req.method === 'GET') {
      const profile = db.getClientProfile(currentAgent.companyId, { phone: query.phone || undefined, email: query.email || undefined });
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
