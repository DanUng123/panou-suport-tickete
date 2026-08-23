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
    requesterPhone TEXT DEFAULT '',
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    assignedTo TEXT,
    relatedOrderId TEXT REFERENCES orders(id) ON DELETE SET NULL,
    section TEXT NOT NULL DEFAULT 'support',
    sectionCode TEXT,
    stage TEXT,
    pickupAwbNumber TEXT,
    pickupAwbParcelId TEXT,
    pickupAwbLabelPdf TEXT,
    pickupAwbCreatedAt TEXT,
    pickupAwbCourier TEXT,
    pickupAwbSecondaryNumber TEXT,
    pickupAddress TEXT,
    pickupCity TEXT,
    pickupPostalCode TEXT,
    pickupPhone TEXT,
    returnAwbNumber TEXT,
    returnAwbParcelId TEXT,
    returnAwbLabelPdf TEXT,
    returnAwbCreatedAt TEXT,
    returnAwbCourier TEXT,
    refundIban TEXT,
    refundAccountHolder TEXT,
    refundAmount REAL,
    refundReason TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    resolvedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS section_counters (
    section TEXT PRIMARY KEY,
    nextSeq INTEGER NOT NULL DEFAULT 1
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
    paymentMethodCode TEXT,
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

  CREATE TABLE IF NOT EXISTS ticket_photos (
    id TEXT PRIMARY KEY,
    ticketId TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    dataBase64 TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_shippingStatus ON orders(shippingStatus);
  CREATE INDEX IF NOT EXISTS idx_orders_paymentStatus ON orders(paymentStatus);
  CREATE INDEX IF NOT EXISTS idx_orders_internalStatus ON orders(internalStatus);
  CREATE INDEX IF NOT EXISTS idx_orders_assignedTo ON orders(assignedTo);
  CREATE INDEX IF NOT EXISTS idx_order_notes_orderId ON order_notes(orderId);
  CREATE INDEX IF NOT EXISTS idx_ticket_photos_ticketId ON ticket_photos(ticketId);

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
  if (!cols.includes('section')) {
    db.exec("ALTER TABLE tickets ADD COLUMN section TEXT NOT NULL DEFAULT 'support'");
  }
  if (!cols.includes('pickupAwbNumber')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupAwbNumber TEXT');
  }
  if (!cols.includes('pickupAwbParcelId')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupAwbParcelId TEXT');
  }
  if (!cols.includes('pickupAwbLabelPdf')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupAwbLabelPdf TEXT');
  }
  if (!cols.includes('pickupAwbCreatedAt')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupAwbCreatedAt TEXT');
  }
  if (!cols.includes('pickupAddress')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupAddress TEXT');
  }
  if (!cols.includes('pickupCity')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupCity TEXT');
  }
  if (!cols.includes('pickupPostalCode')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupPostalCode TEXT');
  }
  if (!cols.includes('pickupPhone')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupPhone TEXT');
  }
  if (!cols.includes('sectionCode')) {
    db.exec('ALTER TABLE tickets ADD COLUMN sectionCode TEXT');
  }
  if (!cols.includes('stage')) {
    db.exec('ALTER TABLE tickets ADD COLUMN stage TEXT');
  }
  if (!cols.includes('returnAwbNumber')) {
    db.exec('ALTER TABLE tickets ADD COLUMN returnAwbNumber TEXT');
  }
  if (!cols.includes('returnAwbParcelId')) {
    db.exec('ALTER TABLE tickets ADD COLUMN returnAwbParcelId TEXT');
  }
  if (!cols.includes('returnAwbLabelPdf')) {
    db.exec('ALTER TABLE tickets ADD COLUMN returnAwbLabelPdf TEXT');
  }
  if (!cols.includes('returnAwbCreatedAt')) {
    db.exec('ALTER TABLE tickets ADD COLUMN returnAwbCreatedAt TEXT');
  }
  if (!cols.includes('refundIban')) {
    db.exec('ALTER TABLE tickets ADD COLUMN refundIban TEXT');
  }
  if (!cols.includes('refundAccountHolder')) {
    db.exec('ALTER TABLE tickets ADD COLUMN refundAccountHolder TEXT');
  }
  if (!cols.includes('refundAmount')) {
    db.exec('ALTER TABLE tickets ADD COLUMN refundAmount REAL');
  }
  if (!cols.includes('refundReason')) {
    db.exec('ALTER TABLE tickets ADD COLUMN refundReason TEXT');
  }
  if (!cols.includes('pickupAwbCourier')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupAwbCourier TEXT');
  }
  if (!cols.includes('returnAwbCourier')) {
    db.exec('ALTER TABLE tickets ADD COLUMN returnAwbCourier TEXT');
  }
  if (!cols.includes('pickupAwbSecondaryNumber')) {
    db.exec('ALTER TABLE tickets ADD COLUMN pickupAwbSecondaryNumber TEXT');
  }
  if (!cols.includes('requesterPhone')) {
    db.exec("ALTER TABLE tickets ADD COLUMN requesterPhone TEXT DEFAULT ''");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS section_counters (section TEXT PRIMARY KEY, nextSeq INTEGER NOT NULL DEFAULT 1)`);
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
  if (!cols.includes('paymentMethodCode')) {
    db.exec('ALTER TABLE orders ADD COLUMN paymentMethodCode TEXT');
  }
}
ensureOrdersSchema();

/**
 * Migrare unica: normalizeaza dateCreated/dateModified deja salvate cu fus orar
 * explicit (ex: "...+02:00") la UTC ("...Z"), ca filtrarea pe interval de data
 * sa fie corecta pentru toate comenzile, nu doar cele sincronizate de acum incolo.
 * Idempotenta -- rulata din nou, nu mai schimba nimic (datele deja in UTC raman identice).
 */
function migrateOrderDatesToUtc() {
  const rows = db.prepare("SELECT id, dateCreated, dateModified FROM orders WHERE (dateCreated IS NOT NULL AND dateCreated NOT LIKE '%Z') OR (dateModified IS NOT NULL AND dateModified NOT LIKE '%Z')").all();
  if (!rows.length) return;
  const update = db.prepare('UPDATE orders SET dateCreated = ?, dateModified = ? WHERE id = ?');
  for (const r of rows) {
    update.run(
      r.dateCreated && !r.dateCreated.endsWith('Z') ? (normalizeToUtcIso(r.dateCreated) || r.dateCreated) : r.dateCreated,
      r.dateModified && !r.dateModified.endsWith('Z') ? (normalizeToUtcIso(r.dateModified) || r.dateModified) : r.dateModified,
      r.id
    );
  }
  console.log(`Migrare date comenzi: ${rows.length} normalizate la UTC.`);
}
migrateOrderDatesToUtc();

/**
 * Migrare unica: elimina comenzile deja salvate local care au metoda de
 * plata "card" dar plata nu s-a finalizat (payment_status diferit de
 * "paid") -- acestea nu ar fi trebuit preluate din MerchantPro deloc.
 * Alte metode de plata (ex: ramburs) nu sunt afectate.
 */
function cleanupIncompleteCardOrders() {
  const rows = db.prepare(`
    SELECT id FROM orders
    WHERE (paymentMethodName LIKE '%card%' OR paymentMethodName LIKE '%CARD%' OR paymentMethodCode LIKE '%card%' OR paymentMethodCode LIKE '%CARD%')
      AND (paymentStatus IS NULL OR paymentStatus != 'paid')
  `).all();
  if (!rows.length) return;
  for (const r of rows) {
    db.prepare('DELETE FROM order_notes WHERE orderId = ?').run(r.id);
    db.prepare('UPDATE tickets SET relatedOrderId = NULL WHERE relatedOrderId = ?').run(r.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(r.id);
  }
  console.log(`Curățare comenzi: ${rows.length} cu plată card neterminată eliminate.`);
}
cleanupIncompleteCardOrders();


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
const ALLOWED_SECTIONS = ['support', 'service', 'retur', 'schimb'];

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
  if (filters.section) { clauses.push('section = ?'); params.push(filters.section); }
  if (filters.assignedTo === 'unassigned') {
    clauses.push('assignedTo IS NULL');
  } else if (filters.assignedTo) {
    clauses.push('assignedTo = ?'); params.push(filters.assignedTo);
  }
  if (filters.dateFrom) { clauses.push('createdAt >= ?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { clauses.push('createdAt <= ?'); params.push(filters.dateTo); }
  if (filters.q) {
    clauses.push('(LOWER(subject) LIKE ? OR LOWER(description) LIKE ? OR LOWER(requesterName) LIKE ? OR LOWER(id) LIKE ? OR pickupPhone LIKE ? OR pickupAwbNumber LIKE ?)');
    const q = `%${filters.q.toLowerCase()}%`;
    const qRaw = `%${filters.q}%`;
    params.push(q, q, q, q, qRaw, qRaw);
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
    requesterPhone: input.requesterPhone || '',
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
    INSERT INTO tickets (id, subject, description, requesterName, requesterEmail, requesterPhone, category, priority, status, assignedTo, relatedOrderId, createdAt, updatedAt, resolvedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticket.id, ticket.subject, ticket.description, ticket.requesterName, ticket.requesterEmail, ticket.requesterPhone,
    ticket.category, ticket.priority, ticket.status, ticket.assignedTo, ticket.relatedOrderId,
    ticket.createdAt, ticket.updatedAt, ticket.resolvedAt
  );
  return getTicket(ticket.id);
}

function getTicketsForOrder(orderId) {
  return db.prepare('SELECT id, subject, status, priority, createdAt FROM tickets WHERE relatedOrderId = ? ORDER BY createdAt DESC').all(orderId);
}

/**
 * Salveaza AWB-ul de ridicare pe un tichet si il muta automat in sectiunea
 * corespunzatoare motivului (service/retur).
 */
const SECTION_CODE_PREFIX = { service: 'S', retur: 'R', schimb: 'CS' };

/** Atribuie urmatorul cod secvential pentru o sectiune (S-1, S-2, R-1 ...), rezervandu-l atomic. */
function nextSectionCode(section) {
  const prefix = SECTION_CODE_PREFIX[section];
  if (!prefix) return null;
  db.prepare('INSERT OR IGNORE INTO section_counters (section, nextSeq) VALUES (?, 1)').run(section);
  const row = db.prepare('SELECT nextSeq FROM section_counters WHERE section = ?').get(section);
  db.prepare('UPDATE section_counters SET nextSeq = nextSeq + 1 WHERE section = ?').run(section);
  return `${prefix}-${row.nextSeq}`;
}

function setTicketPickupAwb(ticketId, { awbNumber, parcelId, labelPdf, section, pickupAddress, pickupCity, pickupPostalCode, pickupPhone, courier, secondaryAwbNumber }, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!existing) return null;
  if (!ALLOWED_SECTIONS.includes(section)) throw new Error('Secțiune invalidă');

  const sectionCode = existing.sectionCode || nextSectionCode(section);
  // etapa se seteaza doar daca nu exista deja una -- altfel s-ar reseta gresit
  // la orice re-salvare (ex: re-descarcarea etichetei dupa ce marfa a ajuns deja la service)
  const stage = existing.stage || 'pickup_awb_issued';

  db.prepare(`
    UPDATE tickets SET pickupAwbNumber = ?, pickupAwbParcelId = ?, pickupAwbLabelPdf = ?, pickupAwbCreatedAt = ?, pickupAwbCourier = ?, pickupAwbSecondaryNumber = COALESCE(?, pickupAwbSecondaryNumber),
      section = ?, sectionCode = ?, stage = ?,
      pickupAddress = COALESCE(?, pickupAddress), pickupCity = COALESCE(?, pickupCity),
      pickupPostalCode = COALESCE(?, pickupPostalCode), pickupPhone = COALESCE(?, pickupPhone),
      updatedAt = ?
    WHERE id = ?
  `).run(
    awbNumber, String(parcelId), labelPdf || null, existing.pickupAwbCreatedAt || nowISO(), courier || 'gls', secondaryAwbNumber || null, section, sectionCode, stage,
    pickupAddress || null, pickupCity || null, pickupPostalCode || null, pickupPhone || null,
    nowISO(), ticketId
  );

  if (existing.section !== section) {
    logChange(ticketId, actingAgent, 'section', existing.section, section);
  }
  return getTicket(ticketId);
}

/** Sterge AWB-ul de ridicare de pe un tichet (dupa anulare la GLS). Sectiunea ramane neschimbata. */
function clearTicketPickupAwb(ticketId, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET pickupAwbNumber = NULL, pickupAwbParcelId = NULL, pickupAwbLabelPdf = NULL, pickupAwbCreatedAt = NULL, pickupAwbCourier = NULL, pickupAwbSecondaryNumber = NULL, stage = NULL, section = 'support', updatedAt = ?
    WHERE id = ?
  `).run(nowISO(), ticketId);
  if (existing.section !== 'support') {
    logChange(ticketId, actingAgent, 'section', existing.section, 'support');
  }
  return getTicket(ticketId);
}

/** Salveaza AWB-ul de retur (service -> client, dupa reparatie) si trece etapa la "in drum spre client". */
function setTicketReturnAwb(ticketId, { awbNumber, parcelId, labelPdf, courier }, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET returnAwbNumber = ?, returnAwbParcelId = ?, returnAwbLabelPdf = ?, returnAwbCreatedAt = ?, returnAwbCourier = ?,
      stage = 'return_awb_issued', updatedAt = ?
    WHERE id = ?
  `).run(awbNumber, String(parcelId), labelPdf || null, nowISO(), courier || 'gls', nowISO(), ticketId);
  logChange(ticketId, actingAgent, 'stage', existing.stage, 'return_awb_issued');
  return getTicket(ticketId);
}

/** Sterge AWB-ul de retur (dupa anulare la GLS), revenind etapa la "la service". */
function clearTicketReturnAwb(ticketId, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET returnAwbNumber = NULL, returnAwbParcelId = NULL, returnAwbLabelPdf = NULL, returnAwbCreatedAt = NULL, returnAwbCourier = NULL,
      stage = 'at_service', updatedAt = ?
    WHERE id = ?
  `).run(nowISO(), ticketId);
  return getTicket(ticketId);
}

/** Actualizeaza manual etapa unui tichet, pe baza celui mai recent status de tracking GLS primit. */
function updateTicketStage(ticketId, newStage, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!existing) return null;
  if (existing.stage === newStage) return getTicket(ticketId);
  db.prepare('UPDATE tickets SET stage = ?, updatedAt = ? WHERE id = ?').run(newStage, nowISO(), ticketId);
  logChange(ticketId, actingAgent, 'stage', existing.stage, newStage);
  return getTicket(ticketId);
}

/** Salveaza datele bancare si suma pentru rambursarea unui retur. */
function setTicketRefundInfo(ticketId, { iban, accountHolder, amount, reason }, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET refundIban = ?, refundAccountHolder = ?, refundAmount = ?, refundReason = ?, updatedAt = ?
    WHERE id = ?
  `).run(iban || null, accountHolder || null, amount != null ? Number(amount) : null, reason || null, nowISO(), ticketId);
  logChange(ticketId, actingAgent, 'refundInfo', null, `IBAN salvat, sumă ${amount || '—'}`);
  return getTicket(ticketId);
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
  if (patch.section !== undefined) {
    if (!ALLOWED_SECTIONS.includes(patch.section)) throw new Error('Secțiune invalidă');
    sets.push('section = ?'); params.push(patch.section);
    logChange(ticketId, actingAgent, 'section', existing.section, patch.section);
  }

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
  let invoice = null;
  let proformaUrl = null;
  try {
    const parsed = JSON.parse(rawJson || '{}');
    lineItems = parsed.line_items || [];
    invoice = parsed.invoice || null;
    proformaUrl = parsed.proforma_url || null;
  } catch (e) { /* ignor */ }
  const notes = db.prepare('SELECT * FROM order_notes WHERE orderId = ? ORDER BY createdAt ASC').all(row.id);
  return { ...rest, lineItems, invoice, proformaUrl, notes };
}

/** Insereaza sau actualizeaza o comanda locala, pe baza datelor brute primite de la MerchantPro. */
/**
 * Normalizeaza un timestamp primit de la MerchantPro (ex: "2019-12-05T16:11:23+02:00",
 * cu fus orar explicit, nu UTC) la format UTC ISO ("...Z"), pentru ca filtrarea pe
 * interval de data (text >= / <=) sa fie corecta indiferent de fusul orar al comenzii.
 */
function normalizeToUtcIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value; // pastram valoarea originala daca nu poate fi parsata
  return d.toISOString();
}

function upsertOrderFromMerchantPro(mp) {
  const id = `ORD_${mp.id}`;
  const existing = db.prepare('SELECT id, internalStatus, assignedTo, awbCourier, awbNumber, awbCreatedAt FROM orders WHERE mpId = ?').get(mp.id);

  const fields = {
    id,
    mpId: mp.id,
    paymentStatus: mp.payment_status || null,
    paymentStatusText: mp.payment_status_text || null,
    paymentMethodName: mp.payment_method_name || null,
    paymentMethodCode: mp.payment_method_code || null,
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
    dateCreated: normalizeToUtcIso(mp.date_created),
    dateModified: normalizeToUtcIso(mp.date_modified),
    rawJson: JSON.stringify(mp),
    syncedAt: nowISO(),
  };

  if (existing) {
    db.prepare(`
      UPDATE orders SET
        paymentStatus = ?, paymentStatusText = ?, paymentMethodName = ?, paymentMethodCode = ?,
        shippingStatus = ?, shippingStatusText = ?, shippingMethodName = ?, shippingAwb = ?,
        totalAmount = ?, currency = ?, customerEmail = ?, billingName = ?,
        shippingName = ?, shippingCountryName = ?, shippingState = ?, shippingCity = ?,
        shippingAddress = ?, shippingPostalCode = ?, shippingPhone = ?,
        dateCreated = ?, dateModified = ?, rawJson = ?, syncedAt = ?
      WHERE mpId = ?
    `).run(
      fields.paymentStatus, fields.paymentStatusText, fields.paymentMethodName, fields.paymentMethodCode,
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
      id, mpId, paymentStatus, paymentStatusText, paymentMethodName, paymentMethodCode,
      shippingStatus, shippingStatusText, shippingMethodName, shippingAwb,
      totalAmount, currency, customerEmail, billingName,
      shippingName, shippingCountryName, shippingState, shippingCity,
      shippingAddress, shippingPostalCode, shippingPhone,
      dateCreated, dateModified, rawJson, internalStatus, syncedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(
    fields.id, fields.mpId, fields.paymentStatus, fields.paymentStatusText, fields.paymentMethodName, fields.paymentMethodCode,
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
    clauses.push("(awbNumber IS NULL OR awbNumber = '') AND (shippingAwb IS NULL OR shippingAwb = '')");
  }
  if (filters.hasAwb) {
    clauses.push("((awbNumber IS NOT NULL AND awbNumber != '') OR (shippingAwb IS NOT NULL AND shippingAwb != ''))");
  }
  if (filters.dateFrom) { clauses.push('dateCreated >= ?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { clauses.push('dateCreated <= ?'); params.push(filters.dateTo); }
  if (filters.q) {
    clauses.push('(LOWER(shippingName) LIKE ? OR LOWER(customerEmail) LIKE ? OR LOWER(shippingCity) LIKE ? OR mpId LIKE ? OR shippingPhone LIKE ? OR awbNumber LIKE ? OR shippingAwb LIKE ?)');
    const q = `%${filters.q.toLowerCase()}%`;
    const qRaw = `%${filters.q}%`;
    params.push(q, q, q, qRaw, qRaw, qRaw, qRaw);
  }

  const sql = `SELECT * FROM orders ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY dateCreated DESC`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToOrder);
}

function getOrder(orderId) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  return rowToOrder(row);
}

/** Sterge o comanda locala, identificata dupa mpId (id-ul din MerchantPro). */
function deleteOrderByMpId(mpId) {
  const row = db.prepare('SELECT id FROM orders WHERE mpId = ?').get(mpId);
  if (!row) return false;
  db.prepare('DELETE FROM order_notes WHERE orderId = ?').run(row.id);
  db.prepare('UPDATE tickets SET relatedOrderId = NULL WHERE relatedOrderId = ?').run(row.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(row.id);
  return true;
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

function getOrderStats(filters = {}) {
  // ---- agregari LIVE (fara filtrare de data) -- folosite pentru pastilele de status ----
  const byShippingStatus = {};
  db.prepare('SELECT shippingStatus, COUNT(*) AS c FROM orders GROUP BY shippingStatus').all()
    .forEach((r) => { byShippingStatus[r.shippingStatus || 'necunoscut'] = r.c; });

  const byPaymentStatus = {};
  db.prepare('SELECT paymentStatus, COUNT(*) AS c FROM orders GROUP BY paymentStatus').all()
    .forEach((r) => { byPaymentStatus[r.paymentStatus || 'necunoscut'] = r.c; });

  const needsAwb = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE (awbNumber IS NULL OR awbNumber = '') AND (shippingAwb IS NULL OR shippingAwb = '') AND shippingStatus NOT IN ('cancelled', 'delivered', 'returned')").get().c;
  const withAwb = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE (awbNumber IS NOT NULL AND awbNumber != '') OR (shippingAwb IS NOT NULL AND shippingAwb != '')").get().c;

  // ---- agregari FILTRATE pe interval de data -- folosite doar pentru cardurile de sus ----
  const dateConds = [];
  const dateParams = [];
  if (filters.dateFrom) { dateConds.push('dateCreated >= ?'); dateParams.push(filters.dateFrom); }
  if (filters.dateTo) { dateConds.push('dateCreated <= ?'); dateParams.push(filters.dateTo); }
  const dateWhere = dateConds.length ? `WHERE ${dateConds.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM orders ${dateWhere}`).get(...dateParams).c;

  const byShippingStatusFiltered = {};
  db.prepare(`SELECT shippingStatus, COUNT(*) AS c FROM orders ${dateWhere} GROUP BY shippingStatus`).all(...dateParams)
    .forEach((r) => { byShippingStatusFiltered[r.shippingStatus || 'necunoscut'] = r.c; });

  const lastSync = db.prepare('SELECT MAX(syncedAt) AS t FROM orders').get().t;
  return {
    total,
    shipped: byShippingStatusFiltered.shipped || 0,
    cancelled: byShippingStatusFiltered.cancelled || 0,
    needsAwb, withAwb,
    byShippingStatus, byPaymentStatus, lastSync,
  };
}

/**
 * Profil de client "virtual" -- nu avem o entitate Client persistenta,
 * asa ca agregam toate comenzile si tichetele care au acelasi telefon
 * sau email (normalizate), pentru a arata istoricul complet al clientului
 * din orice comanda/tichet al lui.
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  return digits.length >= 7 ? digits.slice(-9) : null; // ultimele 9 cifre (fara prefix tara)
}

function getClientProfile({ phone, email }) {
  const normPhone = normalizePhone(phone);
  const normEmail = (email || '').trim().toLowerCase() || null;
  if (!normPhone && !normEmail) return { phone: phone || null, email: email || null, orders: [], tickets: [] };

  const allOrders = db.prepare('SELECT * FROM orders ORDER BY dateCreated DESC').all();
  const matchedOrders = allOrders.filter((o) => {
    const p = normalizePhone(o.shippingPhone);
    const e = (o.customerEmail || '').trim().toLowerCase() || null;
    return (normPhone && p === normPhone) || (normEmail && e === normEmail);
  }).map(rowToOrder);

  const allTickets = db.prepare('SELECT * FROM tickets ORDER BY createdAt DESC').all();
  const matchedTickets = allTickets.filter((t) => {
    const p = normalizePhone(t.requesterPhone) || normalizePhone(t.pickupPhone);
    const e = (t.requesterEmail || '').trim().toLowerCase() || null;
    return (normPhone && p === normPhone) || (normEmail && e === normEmail);
  }).map(rowToTicket);

  // numele/telefonul cel mai recent gasite, pentru afisare in antetul profilului
  const bestName = matchedOrders[0]?.shippingName || matchedTickets[0]?.requesterName || null;

  return {
    name: bestName,
    phone: phone || matchedOrders[0]?.shippingPhone || matchedTickets[0]?.requesterPhone || matchedTickets[0]?.pickupPhone || null,
    email: email || matchedOrders[0]?.customerEmail || matchedTickets[0]?.requesterEmail || null,
    orders: matchedOrders,
    tickets: matchedTickets,
  };
}

module.exports.upsertOrderFromMerchantPro = upsertOrderFromMerchantPro;
module.exports.listOrders = listOrders;
module.exports.getOrder = getOrder;
module.exports.getClientProfile = getClientProfile;

const MAX_TICKET_PHOTOS = 6;

/** Adauga o fotografie la un tichet (max 6). Arunca eroare daca limita e deja atinsa. */
function addTicketPhoto(ticketId, { dataBase64, mimeType }) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM ticket_photos WHERE ticketId = ?').get(ticketId).c;
  if (count >= MAX_TICKET_PHOTOS) throw new Error(`Limita de ${MAX_TICKET_PHOTOS} fotografii per tichet a fost atinsă.`);
  const id = genId('PHOTO');
  db.prepare('INSERT INTO ticket_photos (id, ticketId, dataBase64, mimeType, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, ticketId, dataBase64, mimeType, nowISO());
  return { id, ticketId, mimeType, createdAt: nowISO() };
}

/** Lista fotografiilor unui tichet, FARA continutul base64 (doar metadate -- pentru afisare rapida). */
function listTicketPhotos(ticketId) {
  return db.prepare('SELECT id, ticketId, mimeType, createdAt FROM ticket_photos WHERE ticketId = ? ORDER BY createdAt ASC').all(ticketId);
}

/** O fotografie completa (cu continutul base64), pentru servire directa. */
function getTicketPhoto(photoId) {
  return db.prepare('SELECT * FROM ticket_photos WHERE id = ?').get(photoId);
}

function deleteTicketPhoto(photoId) {
  const row = db.prepare('SELECT id FROM ticket_photos WHERE id = ?').get(photoId);
  if (!row) return false;
  db.prepare('DELETE FROM ticket_photos WHERE id = ?').run(photoId);
  return true;
}

module.exports.addTicketPhoto = addTicketPhoto;
module.exports.listTicketPhotos = listTicketPhotos;
module.exports.getTicketPhoto = getTicketPhoto;
module.exports.deleteTicketPhoto = deleteTicketPhoto;
module.exports.deleteOrderByMpId = deleteOrderByMpId;
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
  setTicketPickupAwb,
  clearTicketPickupAwb,
  setTicketReturnAwb,
  clearTicketReturnAwb,
  updateTicketStage,
  setTicketRefundInfo,
  updateTicket,
  addComment,
  getStats,
  ALLOWED_STATUSES,
  ALLOWED_PRIORITIES,
  ALLOWED_ROLES,
  ALLOWED_SECTIONS,
  FIELD_LABELS,
};
