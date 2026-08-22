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
        section: query.section || undefined,
        assignedTo: query.assignedTo || undefined,
        dateFrom: query.dateFrom || undefined,
        dateTo: query.dateTo || undefined,
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
      const status = orderSync.getSyncStatus();
      let platformLabel = 'MERCHANTPRO';
      try {
        const host = new URL(process.env.MERCHANTPRO_SHOP_URL || '').hostname;
        const bareHost = host.replace(/^www\./, '').split('.')[0];
        if (bareHost) platformLabel = bareHost.toUpperCase();
      } catch (e) { /* URL lipsa/invalida, pastram implicitul */ }
      return sendJSON(res, 200, { ...status, platformLabel });
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
      return sendJSON(res, 200, db.getOrderStats({ dateFrom: query.dateFrom || undefined, dateTo: query.dateTo || undefined }));
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

    const orderTicketsMatch = pathname.match(/^\/api\/orders\/([^/]+)\/tickets$/);
    if (orderTicketsMatch && req.method === 'GET') {
      return sendJSON(res, 200, db.getTicketsForOrder(orderTicketsMatch[1]));
    }

    const issueInvoiceMatch = pathname.match(/^\/api\/orders\/([^/]+)\/issue-invoice$/);
    if (issueInvoiceMatch && req.method === 'POST') {
      if (!mp.isConfigured()) return sendJSON(res, 400, { error: 'Integrarea MerchantPro nu este configurată pe server.' });
      const order = db.getOrder(issueInvoiceMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      try {
        await mp.issueInvoice(order.mpId);
        // factura nu vine in raspunsul de mai sus -- resincronizam comanda ca sa o preluam
        const fresh = await mp.getOrder(order.mpId);
        db.upsertOrderFromMerchantPro(fresh);
        return sendJSON(res, 200, db.getOrder(order.id));
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    // ---- AWB / curier GLS ----

    if (pathname === '/api/gls/status' && req.method === 'GET') {
      return sendJSON(res, 200, { configured: gls.isConfigured() });
    }

    if (pathname === '/api/sameday/status' && req.method === 'GET') {
      return sendJSON(res, 200, { configured: sameday.isConfigured() });
    }

    const generateAwbMatch = pathname.match(/^\/api\/orders\/([^/]+)\/generate-awb$/);
    if (generateAwbMatch && req.method === 'POST') {
      if (!gls.isConfigured()) return sendJSON(res, 400, { error: 'Integrarea GLS nu este configurată pe server.' });
      const order = db.getOrder(generateAwbMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      if (!order.shippingAddress || !order.shippingCity || !order.shippingPostalCode || !order.shippingPhone) {
        return sendJSON(res, 400, { error: 'Comanda nu are adresă/telefon complete — verifică datele înainte de a genera AWB.' });
      }
      try {
        const isCod = (order.paymentStatus === 'awaiting');
        const result = await gls.createParcel({
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
        const updated = db.updateOrderInternal(order.id, {
          awbCourier: 'GLS',
          awbNumber: result.trackingNumber,
          awbParcelId: result.parcelId,
          // salvam PDF-ul local, o singura data, cat timp GLS chiar ni-l da --
          // re-cererea lui de la GLS ulterior s-a dovedit nesigura (vezi getLabelPdf)
          awbLabelPdf: result.labelPdf ? result.labelPdf.toString('base64') : undefined,
          internalStatus: 'awb_generated',
        }, currentAgent);
        // incercam si sa scriem AWB-ul inapoi in MerchantPro, dar nu blocam raspunsul daca esueaza
        if (mp.isConfigured()) {
          mp.updateOrder(order.mpId, { shipping_awb: result.trackingNumber }).catch((e) => {
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
      const order = db.getOrder(cancelAwbMatch[1]);
      if (!order) return sendJSON(res, 404, { error: 'Comandă negăsită' });
      if (!order.awbParcelId) return sendJSON(res, 400, { error: 'Comanda nu are AWB generat.' });
      try {
        await gls.deleteParcel(order.awbParcelId);
        const updated = db.updateOrderInternal(order.id, {
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
      const order = db.getOrder(labelMatch[1]);
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
        const pdfBuffer = await gls.getLabelPdf(order.awbParcelId);
        db.updateOrderInternal(order.id, { awbLabelPdf: pdfBuffer.toString('base64') }, currentAgent);
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
      const ticket = db.getTicket(generatePickupMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });

      const body = await readBody(req);
      const reason = ['retur', 'schimb'].includes(body.reason) ? body.reason : 'service';
      const courier = body.courier === 'sameday' ? 'sameday' : 'gls';
      const courierClient = courier === 'sameday' ? sameday : gls;

      if (!courierClient.isConfigured()) {
        return sendJSON(res, 400, { error: `Integrarea ${courier === 'sameday' ? 'Sameday' : 'GLS'} nu este configurată pe server.` });
      }

      // adresa: folosim ce vine explicit in cerere; daca lipseste cate un
      // camp, completam din comanda asociata tichetului (daca exista)
      let linkedOrder = null;
      if (ticket.relatedOrderId) linkedOrder = db.getOrder(ticket.relatedOrderId);

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
        const result = await courierClient.createPickupAwb({
          ticketId: ticket.id, reason, customerName, address, city, postalCode, phone, email,
        });
        const updated = db.setTicketPickupAwb(ticket.id, {
          awbNumber: result.trackingNumber,
          parcelId: result.parcelId,
          labelPdf: result.labelPdf ? result.labelPdf.toString('base64') : null,
          section: reason,
          pickupAddress: address,
          pickupCity: city,
          pickupPostalCode: postalCode,
          pickupPhone: phone,
          courier,
        }, currentAgent);
        return sendJSON(res, 200, { ...updated, labelAvailable: Boolean(result.labelPdf) });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const cancelPickupMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/cancel-pickup-awb$/);
    if (cancelPickupMatch && req.method === 'POST') {
      const ticket = db.getTicket(cancelPickupMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!ticket.pickupAwbParcelId) return sendJSON(res, 400, { error: 'Tichetul nu are AWB de ridicare generat.' });
      try {
        if (ticket.pickupAwbCourier === 'sameday') {
          await sameday.deleteAwb(ticket.pickupAwbParcelId);
        } else {
          await gls.deleteParcel(ticket.pickupAwbParcelId);
        }
        const updated = db.clearTicketPickupAwb(ticket.id, currentAgent);
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const pickupLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/pickup-awb-label$/);
    if (pickupLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(pickupLabelMatch[1]);
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
          ? await sameday.getAwbPdf(ticket.pickupAwbParcelId)
          : await gls.getLabelPdf(ticket.pickupAwbParcelId);
        db.setTicketPickupAwb(ticket.id, {
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
      if (!gls.isConfigured()) return sendJSON(res, 400, { error: 'Integrarea GLS nu este configurată pe server.' });
      const ticket = db.getTicket(generateReturnMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (ticket.section !== 'service') return sendJSON(res, 400, { error: 'AWB-ul de retur e disponibil doar pentru tichetele de Service.' });
      if (!ticket.pickupAddress || !ticket.pickupCity || !ticket.pickupPostalCode || !ticket.pickupPhone) {
        return sendJSON(res, 400, { error: 'Lipsesc datele de adresă ale clientului — nu pot genera AWB-ul de retur.' });
      }
      try {
        const result = await gls.createParcel({
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
        const updated = db.setTicketReturnAwb(ticket.id, {
          awbNumber: result.trackingNumber,
          parcelId: result.parcelId,
          labelPdf: result.labelPdf ? result.labelPdf.toString('base64') : null,
        }, currentAgent);
        return sendJSON(res, 200, { ...updated, labelAvailable: Boolean(result.labelPdf) });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const cancelReturnMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/cancel-return-awb$/);
    if (cancelReturnMatch && req.method === 'POST') {
      const ticket = db.getTicket(cancelReturnMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!ticket.returnAwbParcelId) return sendJSON(res, 400, { error: 'Tichetul nu are AWB de retur generat.' });
      try {
        await gls.deleteParcel(ticket.returnAwbParcelId);
        const updated = db.clearTicketReturnAwb(ticket.id, currentAgent);
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const returnLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/return-awb-label$/);
    if (returnLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(returnLabelMatch[1]);
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
        const pdfBuffer = await gls.getLabelPdf(ticket.returnAwbParcelId);
        db.setTicketReturnAwb(ticket.id, {
          awbNumber: ticket.returnAwbNumber,
          parcelId: ticket.returnAwbParcelId,
          labelPdf: pdfBuffer.toString('base64'),
        }, currentAgent);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="retur-${ticket.returnAwbNumber}.pdf"`,
          'Content-Length': pdfBuffer.length,
        });
        return res.end(pdfBuffer);
      } catch (e) {
        return sendJSON(res, 502, {
          error: `Eticheta nu e salvată local, iar re-cererea ei de la GLS a eșuat (${e.message}). Anulează AWB-ul de retur și generează unul nou.`,
        });
      }
    }

    // ---- actualizare manuala status (etapa) + istoric tracking ----

    const refreshStageMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refresh-awb-status$/);
    if (refreshStageMatch && req.method === 'POST') {
      const ticket = db.getTicket(refreshStageMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });

      // alegem AWB-ul activ (ridicare sau retur) dupa etapa curenta
      const isReturnLeg = ['return_awb_issued', 'in_transit_to_client', 'delivered_to_client'].includes(ticket.stage);
      const trackingNumber = isReturnLeg ? ticket.returnAwbNumber : ticket.pickupAwbNumber;
      const activeCourier = (isReturnLeg ? ticket.returnAwbCourier : ticket.pickupAwbCourier) === 'sameday' ? sameday : gls;
      if (!trackingNumber) return sendJSON(res, 400, { error: 'Tichetul nu are niciun AWB activ de urmărit.' });

      try {
        const statuses = activeCourier === sameday ? await sameday.getAwbStatus(trackingNumber) : await gls.getParcelStatus(trackingNumber);
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

        const updated = db.updateTicketStage(ticket.id, newStage, currentAgent);
        return sendJSON(res, 200, { ...updated, trackingEventsCount: statuses.length });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    const trackingMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/awb-tracking$/);
    if (trackingMatch && req.method === 'GET') {
      const ticket = db.getTicket(trackingMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const leg = query.leg === 'return' ? 'return' : 'pickup';
      const trackingNumber = leg === 'return' ? ticket.returnAwbNumber : ticket.pickupAwbNumber;
      const legCourier = (leg === 'return' ? ticket.returnAwbCourier : ticket.pickupAwbCourier) === 'sameday' ? sameday : gls;
      if (!trackingNumber) return sendJSON(res, 404, { error: 'Nu există AWB pentru acest segment.' });
      try {
        const statuses = legCourier === sameday ? await sameday.getAwbStatus(trackingNumber) : await gls.getParcelStatus(trackingNumber);
        return sendJSON(res, 200, statuses);
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    }

    // ---- profil client (agregat din comenzi + tichete cu acelasi telefon/email) ----

    if (pathname === '/api/clients/lookup' && req.method === 'GET') {
      const profile = db.getClientProfile({ phone: query.phone || undefined, email: query.email || undefined });
      return sendJSON(res, 200, profile);
    }

    // ---- fotografii tichet (max 6, incarcate ca base64 in JSON) ----

    const photosListMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/photos$/);
    if (photosListMatch && req.method === 'GET') {
      return sendJSON(res, 200, db.listTicketPhotos(photosListMatch[1]));
    }
    if (photosListMatch && req.method === 'POST') {
      const ticket = db.getTicket(photosListMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const body = await readBody(req, 30_000_000); // pana la ~30MB (fotografii comprimate pe client)
      if (!body.dataBase64 || !body.mimeType) return sendJSON(res, 400, { error: 'Lipsesc dataBase64 sau mimeType.' });
      if (!/^image\/(jpeg|png|webp)$/.test(body.mimeType)) return sendJSON(res, 400, { error: 'Tip de fișier neacceptat — doar JPEG, PNG sau WEBP.' });
      try {
        const photo = db.addTicketPhoto(ticket.id, { dataBase64: body.dataBase64, mimeType: body.mimeType });
        return sendJSON(res, 200, photo);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    const photoServeMatch = pathname.match(/^\/api\/tickets\/photos\/([^/]+)$/);
    if (photoServeMatch && req.method === 'GET') {
      const photo = db.getTicketPhoto(photoServeMatch[1]);
      if (!photo) return sendJSON(res, 404, { error: 'Fotografie negăsită' });
      const buffer = Buffer.from(photo.dataBase64, 'base64');
      res.writeHead(200, { 'Content-Type': photo.mimeType, 'Content-Length': buffer.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(buffer);
    }
    if (photoServeMatch && req.method === 'DELETE') {
      const ok = db.deleteTicketPhoto(photoServeMatch[1]);
      if (!ok) return sendJSON(res, 404, { error: 'Fotografie negăsită' });
      return sendJSON(res, 200, { ok: true });
    }

    // ---- date bancare rambursare (Retur) + eticheta rambursare (PDF / CSV) ----

    const refundInfoMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refund-info$/);
    if (refundInfoMatch && req.method === 'PATCH') {
      const ticket = db.getTicket(refundInfoMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      const body = await readBody(req);
      if (!body.iban || !String(body.iban).trim()) return sendJSON(res, 400, { error: 'IBAN-ul este obligatoriu.' });
      if (body.amount == null || Number.isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
        return sendJSON(res, 400, { error: 'Suma de returnat trebuie să fie un număr pozitiv.' });
      }
      const updated = db.setTicketRefundInfo(ticket.id, {
        iban: String(body.iban).trim().toUpperCase().replace(/\s+/g, ''),
        accountHolder: body.accountHolder || null,
        amount: body.amount,
        reason: body.reason || null,
      }, currentAgent);
      return sendJSON(res, 200, updated);
    }

    const refundLabelMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/refund-label\.(pdf|csv)$/);
    if (refundLabelMatch && req.method === 'GET') {
      const ticket = db.getTicket(refundLabelMatch[1]);
      if (!ticket) return sendJSON(res, 404, { error: 'Tichet negăsit' });
      if (!ticket.refundIban || ticket.refundAmount == null) {
        return sendJSON(res, 400, { error: 'Completează mai întâi datele bancare și suma de returnat.' });
      }
      let linkedOrder = null;
      if (ticket.relatedOrderId) linkedOrder = db.getOrder(ticket.relatedOrderId);
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
