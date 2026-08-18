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
  return db.findAgentById(entry.agentId);
}

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

// ---------- utilitare HTTP ----------

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => {
      chunks += c;
      if (chunks.length > 2_000_000) {
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
    // ---- auth ----
    if (pathname === '/api/agents' && req.method === 'GET') {
      return sendJSON(res, 200, db.listAgents());
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.agentId) return sendJSON(res, 400, { error: 'Agent lipsă' });

      const lockout = checkLockout(body.agentId);
      if (lockout.locked) {
        return sendJSON(res, 429, { error: `Prea multe încercări eșuate. Încearcă din nou peste ${lockout.minutesLeft} minut(e).` });
      }

      const agent = db.verifyAgent(body.agentId, body.password);
      if (!agent) {
        registerFailedAttempt(body.agentId);
        return sendJSON(res, 401, { error: 'Credențiale invalide' });
      }
      clearFailedAttempts(body.agentId);
      const token = createSession(agent.id);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax`);
      return sendJSON(res, 200, agent);
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const cookie = req.headers.cookie || '';
      const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
      if (match) sessions.delete(match[1]);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const agent = getAgentFromRequest(req);
      if (!agent || !agent.active) return sendJSON(res, 401, { error: 'Neautentificat' });
      const { passwordHash, password, ...safe } = agent;
      return sendJSON(res, 200, { ...safe, active: !!safe.active });
    }

    // toate rutele de mai jos necesită autentificare
    const currentAgent = getAgentFromRequest(req);
    if (!currentAgent || !currentAgent.active) return sendJSON(res, 401, { error: 'Neautentificat' });

    const requireManager = () => currentAgent.role === 'manager';

    if (pathname === '/api/categories' && req.method === 'GET') {
      return sendJSON(res, 200, db.listCategories());
    }

    if (pathname === '/api/categories' && req.method === 'POST') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot gestiona categoriile' });
      const body = await readBody(req);
      try {
        return sendJSON(res, 201, db.addCategory(body.name));
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    const categoryMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
    if (categoryMatch && req.method === 'DELETE') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot gestiona categoriile' });
      return sendJSON(res, 200, db.removeCategory(decodeURIComponent(categoryMatch[1])));
    }

    // ---- administrare agenti (doar manageri) ----

    if (pathname === '/api/admin/agents' && req.method === 'GET') {
      if (!requireManager()) return sendJSON(res, 403, { error: 'Doar managerii pot accesa administrarea' });
      return sendJSON(res, 200, db.listAgents({ includeInactive: true }));
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
        const agent = db.createAgent(body);
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
        const agent = db.updateAgent(adminAgentMatch[1], body);
        if (!agent) return sendJSON(res, 404, { error: 'Agent negăsit' });
        return sendJSON(res, 200, agent);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      return sendJSON(res, 200, db.getStats());
    }

    if (pathname === '/api/tickets' && req.method === 'GET') {
      const filters = {
        status: query.status || undefined,
        priority: query.priority || undefined,
        category: query.category || undefined,
        assignedTo: query.assignedTo || undefined,
        q: query.q || undefined,
        sort: query.sort || undefined,
      };
      return sendJSON(res, 200, db.listTickets(filters));
    }

    if (pathname === '/api/tickets' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.subject || !body.description || !body.requesterName || !body.category) {
        return sendJSON(res, 400, { error: 'Câmpuri obligatorii lipsă (subiect, descriere, solicitant, categorie)' });
      }
      const ticket = db.createTicket(body);
      return sendJSON(res, 201, ticket);
    }

    const ticketMatch = pathname.match(/^\/api\/tickets\/([^/]+)$/);
    if (ticketMatch && req.method === 'GET') {
      const ticket = db.getTicket(ticketMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      return sendJSON(res, 200, ticket);
    }

    if (ticketMatch && req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        const ticket = db.updateTicket(ticketMatch[1], body, currentAgent);
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
      const comment = db.addComment(commentMatch[1], {
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
      return sendJSON(res, 200, orderSync.getSyncStatus());
    }

    if (pathname === '/api/orders/sync' && req.method === 'POST') {
      try {
        const result = await orderSync.runSync();
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    if (pathname === '/api/orders/stats' && req.method === 'GET') {
      return sendJSON(res, 200, db.getOrderStats());
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
      const filters = {
        shippingStatus: query.shippingStatus || undefined,
        paymentStatus: query.paymentStatus || undefined,
        internalStatus: query.internalStatus || undefined,
        assignedTo: query.assignedTo || undefined,
        needsAwb: query.needsAwb === '1' ? true : undefined,
        q: query.q || undefined,
      };
      return sendJSON(res, 200, db.listOrders(filters));
    }

    const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && req.method === 'GET') {
      const order = db.getOrder(orderMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      return sendJSON(res, 200, order);
    }

    if (orderMatch && req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        const order = db.updateOrderInternal(orderMatch[1], body, currentAgent);
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
      const note = db.addOrderNote(orderNoteMatch[1], { agentId: currentAgent.id, agentName: currentAgent.name, body: body.body });
      if (!note) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      return sendJSON(res, 201, note);
    }

    return sendJSON(res, 404, { error: 'Rută necunoscută' });
  } catch (e) {
    return sendJSON(res, 500, { error: e.message || 'Eroare internă' });
  }
}

const server = http.createServer((req, res) => {
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
});
