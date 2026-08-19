// Strat de persistenta bazat pe SQLite, folosind modulul NATIV al Node.js
// (node:sqlite, disponibil din Node 22.5+) -- nu necesita npm install.
//
// Baza de date traieste intr-un singur fisier pe disc: data/app.db
// Pentru gazduire pe Render/Railway etc., acest fisier trebuie sa stea pe
// un "persistent disk" / volum montat (vezi README.md).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword } = require('./password');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
const SEED_FILE = path.join(__dirname, '..', 'data', 'seed.json');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------- schema ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    requesterName TEXT NOT NULL,
    requesterEmail TEXT DEFAULT '',
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    assignedTo TEXT,
    relatedOrderId TEXT REFERENCES orders(id) ON DELETE SET NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    resolvedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    ticketId TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    authorId TEXT NOT NULL,
    authorName TEXT NOT NULL,
    body TEXT NOT NULL,
    internal INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    ticketId TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agentId TEXT,
    agentName TEXT NOT NULL,
    field TEXT NOT NULL,
    oldValue TEXT,
    newValue TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    mpId INTEGER UNIQUE NOT NULL,
    paymentStatus TEXT,
    paymentStatusText TEXT,
    paymentMethodName TEXT,
    shippingStatus TEXT,
    shippingStatusText TEXT,
    shippingMethodName TEXT,
    shippingAwb TEXT,
    totalAmount REAL,
    currency TEXT,
    customerEmail TEXT,
    billingName TEXT,
    shippingName TEXT,
    shippingCountryName TEXT,
    shippingState TEXT,
    shippingCity TEXT,
    shippingAddress TEXT,
    shippingPostalCode TEXT,
    shippingPhone TEXT,
    dateCreated TEXT,
    dateModified TEXT,
    rawJson TEXT,
    internalStatus TEXT NOT NULL DEFAULT 'new',
    assignedTo TEXT,
    awbCourier TEXT,
    awbNumber TEXT,
    awbParcelId TEXT,
    awbLabelPdf TEXT,
    awbCreatedAt TEXT,
    syncedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_notes (
    id TEXT PRIMARY KEY,
    orderId TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    agentId TEXT NOT NULL,
    agentName TEXT NOT NULL,
    body TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_shippingStatus ON orders(shippingStatus);
  CREATE INDEX IF NOT EXISTS idx_orders_paymentStatus ON orders(paymentStatus);
  CREATE INDEX IF NOT EXISTS idx_orders_internalStatus ON orders(internalStatus);
  CREATE INDEX IF NOT EXISTS idx_orders_assignedTo ON orders(assignedTo);
  CREATE INDEX IF NOT EXISTS idx_order_notes_orderId ON order_notes(orderId);

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
  CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
  CREATE INDEX IF NOT EXISTS idx_tickets_assignedTo ON tickets(assignedTo);
  CREATE INDEX IF NOT EXISTS idx_comments_ticketId ON comments(ticketId);
  CREATE INDEX IF NOT EXISTS idx_audit_ticketId ON audit_log(ticketId);
`);

// ---------- migrare schema veche -> noua (pentru instalari deja existente) ----------
// O baza de date creata cu o versiune anterioara a aplicatiei avea coloana
// "password" (text simplu) in loc de "passwordHash", si nu avea "active".
// Migrarea de mai jos aduce orice baza existenta la schema noua, fara sa
// piarda date, si hash-uieste orice parola gasita in clar.

function ensureAgentsSchema() {
  const cols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name);

  if (!cols.includes('passwordHash')) {
    db.exec('ALTER TABLE agents ADD COLUMN passwordHash TEXT');
  }
  if (!cols.includes('active')) {
    db.exec('ALTER TABLE agents ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }

  if (cols.includes('password')) {
    const rows = db.prepare("SELECT id, password FROM agents WHERE (passwordHash IS NULL OR passwordHash = '') AND password IS NOT NULL").all();
    for (const r of rows) {
      db.prepare('UPDATE agents SET passwordHash = ? WHERE id = ?').run(hashPassword(r.password), r.id);
    }
    if (rows.length) {
      console.log(`Migrare: ${rows.length} parolă/parole existente au fost hash-uite.`);
    }
    // eliminam definitiv coloana veche, in clar -- altfel ramane accesibila
    // prin "SELECT *" si poate ajunge, din greseala, in raspunsuri API.
    try {
      db.exec('ALTER TABLE agents DROP COLUMN password');
      console.log('Migrare: coloana veche "password" (text simplu) a fost eliminată din schema.');
    } catch (e) {
      console.error('ATENȚIE: nu am putut elimina coloana veche "password":', e.message);
    }
  }
}

ensureAgentsSchema();

// ---------- seed (doar la prima pornire, cand baza e goala) ----------

function seedIfEmpty() {
  const agentCount = db.prepare('SELECT COUNT(*) AS c FROM agents').get().c;
  if (agentCount > 0) return; // deja populat, nu suprascriem

  if (!fs.existsSync(SEED_FILE)) return;
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));

  const insAgent = db.prepare('INSERT INTO agents (id, name, email, passwordHash, role, active) VALUES (?, ?, ?, ?, ?, 1)');
  for (const a of seed.agents) insAgent.run(a.id, a.name, a.email, hashPassword(a.password), a.role);

  const insCat = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  seed.categories.forEach((c, i) => insCat.run(c, i));

  const insTicket = db.prepare(`
    INSERT INTO tickets (id, subject, description, requesterName, requesterEmail, category, priority, status, assignedTo, createdAt, updatedAt, resolvedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insComment = db.prepare(`
    INSERT INTO comments (id, ticketId, authorId, authorName, body, internal, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of seed.tickets) {
    insTicket.run(
      t.id, t.subject, t.description, t.requesterName, t.requesterEmail || '',
      t.category, t.priority, t.status, t.assignedTo || null,
      t.createdAt, t.updatedAt, t.resolvedAt || null
    );
    for (const c of t.comments || []) {
      insComment.run(c.id, t.id, c.authorId, c.authorName, c.body, c.internal ? 1 : 0, c.createdAt);
    }
  }

  console.log(`Baza de date populată cu date demo (${seed.agents.length} agenți, ${seed.tickets.length} tichete).`);
}

function ensureTicketsSchema() {
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (!cols.includes('relatedOrderId')) {
    db.exec('ALTER TABLE tickets ADD COLUMN relatedOrderId TEXT REFERENCES orders(id) ON DELETE SET NULL');
  }
}
ensureTicketsSchema();

function ensureOrdersSchema() {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('awbParcelId')) {
    db.exec('ALTER TABLE orders ADD COLUMN awbParcelId TEXT');
  }
  if (!cols.includes('awbLabelPdf')) {
    db.exec('ALTER TABLE orders ADD COLUMN awbLabelPdf TEXT');
  }
}
ensureOrdersSchema();

seedIfEmpty();

// ---------- utilitare ----------

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}
function nowISO() {
  return new Date().toISOString();
}

const ALLOWED_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
const ALLOWED_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const ALLOWED_ROLES = ['agent', 'manager'];

const FIELD_LABELS = {
  status: 'status', priority: 'prioritate', category: 'categorie',
  assignedTo: 'agent asignat', subject: 'subiect', description: 'descriere',
};

function commentsForTicket(ticketId) {
  const rows = db.prepare('SELECT * FROM comments WHERE ticketId = ? ORDER BY createdAt ASC').all(ticketId);
  return rows.map((c) => ({ ...c, internal: !!c.internal }));
}

function historyForTicket(ticketId) {
  return db.prepare('SELECT * FROM audit_log WHERE ticketId = ? ORDER BY createdAt ASC').all(ticketId);
}

function rowToTicket(row) {
  if (!row) return null;
  return { ...row, comments: commentsForTicket(row.id), history: historyForTicket(row.id) };
}

function logChange(ticketId, agent, field, oldValue, newValue) {
  if (oldValue === newValue) return;
  db.prepare(`
    INSERT INTO audit_log (id, ticketId, agentId, agentName, field, oldValue, newValue, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(genId('AUD'), ticketId, agent.id, agent.name, field, oldValue ?? null, newValue ?? null, nowISO());
}

// ---------- agenti ----------

function listAgents({ includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT id, name, email, role, active FROM agents ORDER BY name ASC'
    : 'SELECT id, name, email, role, active FROM agents WHERE active = 1 ORDER BY name ASC';
  return db.prepare(sql).all().map((a) => ({ ...a, active: !!a.active }));
}

function findAgentById(agentId) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) || null;
}

function verifyAgent(agentId, password) {
  const agent = findAgentById(agentId);
  if (!agent || !agent.active) return null;
  if (!verifyPassword(password, agent.passwordHash)) return null;
  const { passwordHash: _ph, password: _pw, ...safe } = agent;
  return { ...safe, active: !!safe.active };
}

function createAgent({ name, email, password, role }) {
  if (!ALLOWED_ROLES.includes(role)) throw new Error('Rol invalid');
  const agent = { id: genId('AGT'), name, email, role, active: 1 };
  db.prepare('INSERT INTO agents (id, name, email, passwordHash, role, active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(agent.id, name, email, hashPassword(password), role);
  return { ...agent, active: true };
}

function updateAgent(agentId, patch) {
  const existing = findAgentById(agentId);
  if (!existing) return null;

  const sets = [];
  const params = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.email !== undefined) { sets.push('email = ?'); params.push(patch.email); }
  if (patch.role !== undefined) {
    if (!ALLOWED_ROLES.includes(patch.role)) throw new Error('Rol invalid');
    sets.push('role = ?'); params.push(patch.role);
  }
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (patch.password) { sets.push('passwordHash = ?'); params.push(hashPassword(patch.password)); }

  if (!sets.length) return findAgentById(agentId);
  params.push(agentId);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const { passwordHash: _ph, password: _pw, ...safe } = findAgentById(agentId);
  return { ...safe, active: !!safe.active };
}

// ---------- categorii ----------

function listCategories() {
  return db.prepare('SELECT name FROM categories ORDER BY sort_order ASC').all().map((r) => r.name);
}

function addCategory(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Numele categoriei nu poate fi gol');
  const existing = db.prepare('SELECT name FROM categories WHERE name = ?').get(trimmed);
  if (existing) throw new Error('Categoria există deja');
  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM categories').get().m;
  db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(trimmed, (maxOrder ?? -1) + 1);
  return listCategories();
}

function removeCategory(name) {
  db.prepare('DELETE FROM categories WHERE name = ?').run(name);
  return listCategories();
}

// ---------- tichete ----------

function listTickets(filters = {}) {
  const clauses = [];
  const params = [];

  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.priority) { clauses.push('priority = ?'); params.push(filters.priority); }
  if (filters.category) { clauses.push('category = ?'); params.push(filters.category); }
  if (filters.assignedTo === 'unassigned') {
    clauses.push('assignedTo IS NULL');
  } else if (filters.assignedTo) {
    clauses.push('assignedTo = ?'); params.push(filters.assignedTo);
  }
  if (filters.q) {
    clauses.push('(LOWER(subject) LIKE ? OR LOWER(description) LIKE ? OR LOWER(requesterName) LIKE ? OR LOWER(id) LIKE ?)');
    const q = `%${filters.q.toLowerCase()}%`;
    params.push(q, q, q, q);
  }

  let orderBy = 'createdAt DESC';
  if (filters.sort === 'oldest') orderBy = 'createdAt ASC';
  if (filters.sort === 'priority') {
    orderBy = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC, createdAt DESC`;
  }

  const sql = `SELECT * FROM tickets ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY ${orderBy}`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToTicket);
}

function getTicket(ticketId) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  return rowToTicket(row);
}

function createTicket(input) {
  const ticket = {
    id: genId('TCK'),
    subject: input.subject,
    description: input.description,
    requesterName: input.requesterName,
    requesterEmail: input.requesterEmail || '',
    category: input.category,
    priority: input.priority || 'medium',
    status: 'open',
    assignedTo: input.assignedTo || null,
    relatedOrderId: input.relatedOrderId || null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    resolvedAt: null,
  };
  db.prepare(`
    INSERT INTO tickets (id, subject, description, requesterName, requesterEmail, category, priority, status, assignedTo, relatedOrderId, createdAt, updatedAt, resolvedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticket.id, ticket.subject, ticket.description, ticket.requesterName, ticket.requesterEmail,
    ticket.category, ticket.priority, ticket.status, ticket.assignedTo, ticket.relatedOrderId,
    ticket.createdAt, ticket.updatedAt, ticket.resolvedAt
  );
  return getTicket(ticket.id);
}

function getTicketsForOrder(orderId) {
  return db.prepare('SELECT id, subject, status, priority, createdAt FROM tickets WHERE relatedOrderId = ? ORDER BY createdAt DESC').all(orderId);
}

function updateTicket(ticketId, patch, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!existing) return null;

  const sets = [];
  const params = [];

  if (patch.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(patch.status)) throw new Error('Status invalid');
    sets.push('status = ?'); params.push(patch.status);
    if ((patch.status === 'resolved' || patch.status === 'closed') && !existing.resolvedAt) {
      sets.push('resolvedAt = ?'); params.push(nowISO());
    }
    if (patch.status !== 'resolved' && patch.status !== 'closed') {
      sets.push('resolvedAt = NULL');
    }
    logChange(ticketId, actingAgent, 'status', existing.status, patch.status);
  }
  if (patch.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.includes(patch.priority)) throw new Error('Prioritate invalida');
    sets.push('priority = ?'); params.push(patch.priority);
    logChange(ticketId, actingAgent, 'priority', existing.priority, patch.priority);
  }
  if (patch.category !== undefined) {
    sets.push('category = ?'); params.push(patch.category);
    logChange(ticketId, actingAgent, 'category', existing.category, patch.category);
  }
  if (patch.assignedTo !== undefined) {
    const newVal = patch.assignedTo || null;
    sets.push('assignedTo = ?'); params.push(newVal);
    const oldAgent = existing.assignedTo ? findAgentById(existing.assignedTo) : null;
    const newAgent = newVal ? findAgentById(newVal) : null;
    logChange(ticketId, actingAgent, 'assignedTo', oldAgent ? oldAgent.name : null, newAgent ? newAgent.name : null);
  }
  if (patch.subject !== undefined) { sets.push('subject = ?'); params.push(patch.subject); }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }

  sets.push('updatedAt = ?'); params.push(nowISO());
  params.push(ticketId);

  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getTicket(ticketId);
}

function addComment(ticketId, { authorId, authorName, body, internal }) {
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return null;

  const comment = {
    id: genId('CMT'),
    ticketId,
    authorId,
    authorName,
    body,
    internal: internal ? 1 : 0,
    createdAt: nowISO(),
  };
  db.prepare(`
    INSERT INTO comments (id, ticketId, authorId, authorName, body, internal, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(comment.id, comment.ticketId, comment.authorId, comment.authorName, comment.body, comment.internal, comment.createdAt);

  db.prepare('UPDATE tickets SET updatedAt = ? WHERE id = ?').run(nowISO(), ticketId);

  return { ...comment, internal: !!comment.internal };
}

// ---------- statistici ----------

function getStats() {
  const byStatus = {};
  ALLOWED_STATUSES.forEach((s) => (byStatus[s] = 0));
  db.prepare('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status').all()
    .forEach((r) => { byStatus[r.status] = r.c; });

  const byPriority = {};
  ALLOWED_PRIORITIES.forEach((p) => (byPriority[p] = 0));
  db.prepare('SELECT priority, COUNT(*) AS c FROM tickets GROUP BY priority').all()
    .forEach((r) => { byPriority[r.priority] = r.c; });

  const byCategory = {};
  db.prepare('SELECT category, COUNT(*) AS c FROM tickets GROUP BY category').all()
    .forEach((r) => { byCategory[r.category] = r.c; });

  const byAgentOpenCount = {};
  db.prepare(`
    SELECT assignedTo, COUNT(*) AS c FROM tickets
    WHERE assignedTo IS NOT NULL AND status NOT IN ('resolved', 'closed')
    GROUP BY assignedTo
  `).all().forEach((r) => { byAgentOpenCount[r.assignedTo] = r.c; });

  const total = db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c;

  const cutoffISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const resolvedToday = db.prepare('SELECT COUNT(*) AS c FROM tickets WHERE resolvedAt IS NOT NULL AND resolvedAt >= ?').get(cutoffISO).c;

  const durations = db.prepare('SELECT createdAt, resolvedAt FROM tickets WHERE resolvedAt IS NOT NULL').all()
    .map((r) => new Date(r.resolvedAt) - new Date(r.createdAt));
  const avgResolutionHours = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length / (1000 * 60 * 60)
    : null;

  const unassigned = db.prepare(`
    SELECT COUNT(*) AS c FROM tickets WHERE assignedTo IS NULL AND status NOT IN ('resolved', 'closed')
  `).get().c;

  return { total, byStatus, byPriority, byCategory, byAgentOpenCount, resolvedToday, avgResolutionHours, unassigned };
}

// ---------- comenzi (sincronizate din MerchantPro) ----------

const ALLOWED_INTERNAL_ORDER_STATUSES = ['new', 'processing', 'awb_generated', 'shipped', 'problem', 'done'];

function rowToOrder(row) {
  if (!row) return null;
  const { rawJson, ...rest } = row;
  let lineItems = [];
  try { lineItems = JSON.parse(rawJson || '{}').line_items || []; } catch (e) { /* ignor */ }
  const notes = db.prepare('SELECT * FROM order_notes WHERE orderId = ? ORDER BY createdAt ASC').all(row.id);
  return { ...rest, lineItems, notes };
}

/** Insereaza sau actualizeaza o comanda locala, pe baza datelor brute primite de la MerchantPro. */
function upsertOrderFromMerchantPro(mp) {
  const id = `ORD_${mp.id}`;
  const existing = db.prepare('SELECT id, internalStatus, assignedTo, awbCourier, awbNumber, awbCreatedAt FROM orders WHERE mpId = ?').get(mp.id);

  const fields = {
    id,
    mpId: mp.id,
    paymentStatus: mp.payment_status || null,
    paymentStatusText: mp.payment_status_text || null,
    paymentMethodName: mp.payment_method_name || null,
    shippingStatus: mp.shipping_status || null,
    shippingStatusText: mp.shipping_status_text || null,
    shippingMethodName: mp.shipping_method_name || null,
    shippingAwb: mp.shipping_awb || null,
    totalAmount: mp.total_amount ?? null,
    currency: mp.currency || null,
    customerEmail: mp.customer_email || null,
    billingName: mp.billing_name || null,
    shippingName: mp.shipping_name || null,
    shippingCountryName: mp.shipping_country_name || null,
    shippingState: mp.shipping_state || null,
    shippingCity: mp.shipping_city || null,
    shippingAddress: mp.shipping_address || null,
    shippingPostalCode: mp.shipping_postal_code || null,
    shippingPhone: mp.shipping_phone || null,
    dateCreated: mp.date_created || null,
    dateModified: mp.date_modified || null,
    rawJson: JSON.stringify(mp),
    syncedAt: nowISO(),
  };

  if (existing) {
    db.prepare(`
      UPDATE orders SET
        paymentStatus = ?, paymentStatusText = ?, paymentMethodName = ?,
        shippingStatus = ?, shippingStatusText = ?, shippingMethodName = ?, shippingAwb = ?,
        totalAmount = ?, currency = ?, customerEmail = ?, billingName = ?,
        shippingName = ?, shippingCountryName = ?, shippingState = ?, shippingCity = ?,
        shippingAddress = ?, shippingPostalCode = ?, shippingPhone = ?,
        dateCreated = ?, dateModified = ?, rawJson = ?, syncedAt = ?
      WHERE mpId = ?
    `).run(
      fields.paymentStatus, fields.paymentStatusText, fields.paymentMethodName,
      fields.shippingStatus, fields.shippingStatusText, fields.shippingMethodName, fields.shippingAwb,
      fields.totalAmount, fields.currency, fields.customerEmail, fields.billingName,
      fields.shippingName, fields.shippingCountryName, fields.shippingState, fields.shippingCity,
      fields.shippingAddress, fields.shippingPostalCode, fields.shippingPhone,
      fields.dateCreated, fields.dateModified, fields.rawJson, fields.syncedAt,
      mp.id
    );
    return { id: existing.id, isNew: false };
  }

  db.prepare(`
    INSERT INTO orders (
      id, mpId, paymentStatus, paymentStatusText, paymentMethodName,
      shippingStatus, shippingStatusText, shippingMethodName, shippingAwb,
      totalAmount, currency, customerEmail, billingName,
      shippingName, shippingCountryName, shippingState, shippingCity,
      shippingAddress, shippingPostalCode, shippingPhone,
      dateCreated, dateModified, rawJson, internalStatus, syncedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(
    fields.id, fields.mpId, fields.paymentStatus, fields.paymentStatusText, fields.paymentMethodName,
    fields.shippingStatus, fields.shippingStatusText, fields.shippingMethodName, fields.shippingAwb,
    fields.totalAmount, fields.currency, fields.customerEmail, fields.billingName,
    fields.shippingName, fields.shippingCountryName, fields.shippingState, fields.shippingCity,
    fields.shippingAddress, fields.shippingPostalCode, fields.shippingPhone,
    fields.dateCreated, fields.dateModified, fields.rawJson, fields.syncedAt
  );
  return { id, isNew: true };
}

function listOrders(filters = {}) {
  const clauses = [];
  const params = [];

  if (filters.shippingStatus) { clauses.push('shippingStatus = ?'); params.push(filters.shippingStatus); }
  if (filters.paymentStatus) { clauses.push('paymentStatus = ?'); params.push(filters.paymentStatus); }
  if (filters.internalStatus) { clauses.push('internalStatus = ?'); params.push(filters.internalStatus); }
  if (filters.assignedTo === 'unassigned') {
    clauses.push('assignedTo IS NULL');
  } else if (filters.assignedTo) {
    clauses.push('assignedTo = ?'); params.push(filters.assignedTo);
  }
  if (filters.needsAwb) {
    clauses.push("(awbNumber IS NULL OR awbNumber = '')");
  }
  if (filters.q) {
    clauses.push('(LOWER(shippingName) LIKE ? OR LOWER(customerEmail) LIKE ? OR LOWER(shippingCity) LIKE ? OR mpId LIKE ?)');
    const q = `%${filters.q.toLowerCase()}%`;
    params.push(q, q, q, `%${filters.q}%`);
  }

  const sql = `SELECT * FROM orders ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY dateCreated DESC`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToOrder);
}

function getOrder(orderId) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  return rowToOrder(row);
}

function updateOrderInternal(orderId, patch, actingAgent) {
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!existing) return null;

  const sets = [];
  const params = [];

  if (patch.internalStatus !== undefined) {
    if (!ALLOWED_INTERNAL_ORDER_STATUSES.includes(patch.internalStatus)) throw new Error('Status intern invalid');
    sets.push('internalStatus = ?'); params.push(patch.internalStatus);
  }
  if (patch.assignedTo !== undefined) { sets.push('assignedTo = ?'); params.push(patch.assignedTo || null); }
  if (patch.awbCourier !== undefined) { sets.push('awbCourier = ?'); params.push(patch.awbCourier || null); }
  if (patch.awbParcelId !== undefined) { sets.push('awbParcelId = ?'); params.push(patch.awbParcelId !== null ? String(patch.awbParcelId) : null); }
  if (patch.awbLabelPdf !== undefined) { sets.push('awbLabelPdf = ?'); params.push(patch.awbLabelPdf || null); }
  if (patch.awbNumber !== undefined) {
    sets.push('awbNumber = ?'); params.push(patch.awbNumber || null);
    sets.push('awbCreatedAt = ?'); params.push(patch.awbNumber ? nowISO() : null);
  }

  if (!sets.length) return getOrder(orderId);
  params.push(orderId);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getOrder(orderId);
}

function addOrderNote(orderId, { agentId, agentName, body }) {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const note = { id: genId('ONT'), orderId, agentId, agentName, body, createdAt: nowISO() };
  db.prepare('INSERT INTO order_notes (id, orderId, agentId, agentName, body, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(note.id, note.orderId, note.agentId, note.agentName, note.body, note.createdAt);
  return note;
}

function getOrderStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
  const needsAwb = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE (awbNumber IS NULL OR awbNumber = '') AND shippingStatus NOT IN ('cancelled', 'delivered', 'returned')").get().c;
  const byShippingStatus = {};
  db.prepare('SELECT shippingStatus, COUNT(*) AS c FROM orders GROUP BY shippingStatus').all()
    .forEach((r) => { byShippingStatus[r.shippingStatus || 'necunoscut'] = r.c; });
  const lastSync = db.prepare('SELECT MAX(syncedAt) AS t FROM orders').get().t;
  return { total, needsAwb, byShippingStatus, lastSync };
}

module.exports.upsertOrderFromMerchantPro = upsertOrderFromMerchantPro;
module.exports.listOrders = listOrders;
module.exports.getOrder = getOrder;
module.exports.updateOrderInternal = updateOrderInternal;
module.exports.addOrderNote = addOrderNote;
module.exports.getOrderStats = getOrderStats;
module.exports.ALLOWED_INTERNAL_ORDER_STATUSES = ALLOWED_INTERNAL_ORDER_STATUSES;

module.exports = {
  ...module.exports,
  listAgents,
  findAgentById,
  verifyAgent,
  createAgent,
  updateAgent,
  listCategories,
  addCategory,
  removeCategory,
  listTickets,
  getTicket,
  createTicket,
  getTicketsForOrder,
  updateTicket,
  addComment,
  getStats,
  ALLOWED_STATUSES,
  ALLOWED_PRIORITIES,
  ALLOWED_ROLES,
  FIELD_LABELS,
};
