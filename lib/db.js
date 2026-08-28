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

// ---------- criptare credentiale sensibile (parole curier, chei API) ----------
// Foloseste AES-256-GCM, cu o cheie unica de server (ENCRYPTION_KEY, variabila
// de mediu -- NU per-companie, e cheia "master" care protejeaza toate datele
// criptate din baza de date). Daca lipseste, se genereaza una temporara la
// pornire (functioneaza, dar datele criptate devin ilizibile dupa un restart
// -- setati ENCRYPTION_KEY explicit pe Render pentru productie).
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest()
  : crypto.randomBytes(32);
if (!process.env.ENCRYPTION_KEY) {
  console.warn('ATENTIE: ENCRYPTION_KEY nu este setata -- credentialele criptate nu vor supravietui unui restart al serverului. Setati ENCRYPTION_KEY pe Render.');
}

function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptSecret(stored) {
  if (!stored) return null;
  try {
    const data = Buffer.from(stored, 'base64');
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    return null; // cheia s-a schimbat (restart fara ENCRYPTION_KEY setata) sau date corupte
  }
}

// ---------- schema ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    merchantProShopUrl TEXT,
    merchantProApiKey TEXT,
    merchantProApiSecretEnc TEXT,
    glsUsername TEXT,
    glsPasswordEnc TEXT,
    glsClientNumber TEXT,
    glsSenderName TEXT,
    glsSenderAddress TEXT,
    glsSenderCity TEXT,
    glsSenderZipcode TEXT,
    glsSenderContact TEXT,
    glsSenderPhone TEXT,
    glsSenderEmail TEXT,
    samedayUsername TEXT,
    samedayPasswordEnc TEXT,
    samedayEnvironment TEXT,
    samedayPickupPointId TEXT,
    samedayPickupPointAddress TEXT,
    samedayContactPersonId TEXT,
    samedaySenderName TEXT,
    samedaySenderPhone TEXT,
    samedaySenderPostalCode TEXT,
    samedaySenderAddress TEXT
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS categories (
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (companyId, name)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
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
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    section TEXT NOT NULL,
    nextSeq INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (companyId, section)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    ticketId TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    authorId TEXT NOT NULL,
    authorName TEXT NOT NULL,
    body TEXT NOT NULL,
    internal INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
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
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    mpId INTEGER NOT NULL,
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
    syncedAt TEXT NOT NULL,
    UNIQUE (companyId, mpId)
  );

  CREATE TABLE IF NOT EXISTS order_notes (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    orderId TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    agentId TEXT NOT NULL,
    agentName TEXT NOT NULL,
    body TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ticket_photos (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    ticketId TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    dataBase64 TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT,
    phone TEXT NOT NULL,
    phoneNormalized TEXT NOT NULL,
    email TEXT,
    address TEXT,
    city TEXT,
    county TEXT,
    extraJson TEXT,
    createdAt TEXT NOT NULL,
    UNIQUE (companyId, phoneNormalized)
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

  // companie demo, pentru testare locala -- izolata complet de companiile
  // reale create prin /api/signup, nu le afecteaza in niciun fel
  const demoCompanyId = genId('CO');
  db.prepare('INSERT INTO companies (id, name, createdAt) VALUES (?, ?, ?)').run(demoCompanyId, 'Companie Demo', nowISO());

  const insAgent = db.prepare('INSERT INTO agents (id, companyId, name, email, passwordHash, role, active) VALUES (?, ?, ?, ?, ?, ?, 1)');
  for (const a of seed.agents) insAgent.run(a.id, demoCompanyId, a.name, a.email.toLowerCase(), hashPassword(a.password), a.role);

  const insCat = db.prepare('INSERT INTO categories (companyId, name, sort_order) VALUES (?, ?, ?)');
  seed.categories.forEach((c, i) => insCat.run(demoCompanyId, c, i));

  const insTicket = db.prepare(`
    INSERT INTO tickets (id, companyId, subject, description, requesterName, requesterEmail, category, priority, status, assignedTo, createdAt, updatedAt, resolvedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insComment = db.prepare(`
    INSERT INTO comments (id, companyId, ticketId, authorId, authorName, body, internal, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of seed.tickets) {
    insTicket.run(
      t.id, demoCompanyId, t.subject, t.description, t.requesterName, t.requesterEmail || '',
      t.category, t.priority, t.status, t.assignedTo || null,
      t.createdAt, t.updatedAt, t.resolvedAt || null
    );
    for (const c of t.comments || []) {
      insComment.run(c.id, demoCompanyId, t.id, c.authorId, c.authorName, c.body, c.internal ? 1 : 0, c.createdAt);
    }
  }

  console.log(`Baza de date populată cu date demo (${seed.agents.length} agenți, ${seed.tickets.length} tichete, companie demo "${demoCompanyId}").`);
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
  if (!cols.includes('refundPaidAt')) {
    db.exec('ALTER TABLE tickets ADD COLUMN refundPaidAt TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS section_counters (section TEXT PRIMARY KEY, nextSeq INTEGER NOT NULL DEFAULT 1)`);
}
ensureTicketsSchema();

function ensureClientsSchema() {
  const cols = db.prepare('PRAGMA table_info(clients)').all().map((c) => c.name);
  if (!cols.includes('county')) {
    db.exec('ALTER TABLE clients ADD COLUMN county TEXT');
  }
}
ensureClientsSchema();

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

function logChange(companyId, ticketId, agent, field, oldValue, newValue) {
  if (oldValue === newValue) return;
  db.prepare(`
    INSERT INTO audit_log (id, companyId, ticketId, agentId, agentName, field, oldValue, newValue, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(genId('AUD'), companyId, ticketId, agent.id, agent.name, field, oldValue ?? null, newValue ?? null, nowISO());
}

// ---------- agenti ----------

// ---------- companii ----------

/** Creeaza o companie noua + primul cont (manager). Folosita la inscriere publica. */
function createCompany({ companyName, agentName, email, password }) {
  const companyId = genId('CO');
  db.prepare('INSERT INTO companies (id, name, createdAt) VALUES (?, ?, ?)').run(companyId, companyName, nowISO());

  // categorii implicite, pentru orice companie noua
  const defaultCategories = ['Livrare', 'Produs defect', 'Facturare', 'Cont', 'Altele'];
  const insCat = db.prepare('INSERT INTO categories (companyId, name, sort_order) VALUES (?, ?, ?)');
  defaultCategories.forEach((c, i) => insCat.run(companyId, c, i));

  const agent = createAgent(companyId, { name: agentName, email, password, role: 'manager' });
  return { company: { id: companyId, name: companyName }, agent };
}

/** Lista TUTUROR companiilor (cu credentiale decriptate) -- folosita doar intern, pentru sincronizarea periodica din fundal. Nu se expune direct printr-o ruta API. */
function listAllCompanies() {
  const ids = db.prepare('SELECT id FROM companies').all().map((r) => r.id);
  return ids.map(getCompany);
}
module.exports.listAllCompanies = listAllCompanies;

function getCompany(companyId) {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    merchantProShopUrl: row.merchantProShopUrl,
    merchantProApiKey: row.merchantProApiKey,
    merchantProApiSecret: decryptSecret(row.merchantProApiSecretEnc),
    glsUsername: row.glsUsername,
    glsPassword: decryptSecret(row.glsPasswordEnc),
    glsClientNumber: row.glsClientNumber,
    glsSenderName: row.glsSenderName,
    glsSenderAddress: row.glsSenderAddress,
    glsSenderCity: row.glsSenderCity,
    glsSenderZipcode: row.glsSenderZipcode,
    glsSenderContact: row.glsSenderContact,
    glsSenderPhone: row.glsSenderPhone,
    glsSenderEmail: row.glsSenderEmail,
    samedayUsername: row.samedayUsername,
    samedayPassword: decryptSecret(row.samedayPasswordEnc),
    samedayEnvironment: row.samedayEnvironment,
    samedayPickupPointId: row.samedayPickupPointId,
    samedayPickupPointAddress: row.samedayPickupPointAddress,
    samedayContactPersonId: row.samedayContactPersonId,
    samedaySenderName: row.samedaySenderName,
    samedaySenderPhone: row.samedaySenderPhone,
    samedaySenderPostalCode: row.samedaySenderPostalCode,
    samedaySenderAddress: row.samedaySenderAddress,
  };
}

function updateCompanyCredentials(companyId, patch) {
  const fields = {
    merchantProShopUrl: patch.merchantProShopUrl,
    merchantProApiKey: patch.merchantProApiKey,
    merchantProApiSecretEnc: patch.merchantProApiSecret !== undefined ? encryptSecret(patch.merchantProApiSecret) : undefined,
    glsUsername: patch.glsUsername,
    glsPasswordEnc: patch.glsPassword !== undefined ? encryptSecret(patch.glsPassword) : undefined,
    glsClientNumber: patch.glsClientNumber,
    glsSenderName: patch.glsSenderName,
    glsSenderAddress: patch.glsSenderAddress,
    glsSenderCity: patch.glsSenderCity,
    glsSenderZipcode: patch.glsSenderZipcode,
    glsSenderContact: patch.glsSenderContact,
    glsSenderPhone: patch.glsSenderPhone,
    glsSenderEmail: patch.glsSenderEmail,
    samedayUsername: patch.samedayUsername,
    samedayPasswordEnc: patch.samedayPassword !== undefined ? encryptSecret(patch.samedayPassword) : undefined,
    samedayEnvironment: patch.samedayEnvironment,
    samedayPickupPointId: patch.samedayPickupPointId,
    samedayPickupPointAddress: patch.samedayPickupPointAddress,
    samedayContactPersonId: patch.samedayContactPersonId,
    samedaySenderName: patch.samedaySenderName,
    samedaySenderPhone: patch.samedaySenderPhone,
    samedaySenderPostalCode: patch.samedaySenderPostalCode,
    samedaySenderAddress: patch.samedaySenderAddress,
  };
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) { sets.push(`${col} = ?`); params.push(val); }
  }
  if (!sets.length) return getCompany(companyId);
  params.push(companyId);
  db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getCompany(companyId);
}

module.exports.createCompany = createCompany;
module.exports.getCompany = getCompany;
module.exports.updateCompanyCredentials = updateCompanyCredentials;

function listAgents(companyId, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT id, name, email, role, active FROM agents WHERE companyId = ? ORDER BY name ASC'
    : 'SELECT id, name, email, role, active FROM agents WHERE companyId = ? AND active = 1 ORDER BY name ASC';
  return db.prepare(sql).all(companyId).map((a) => ({ ...a, active: !!a.active }));
}

/** Cautare globala dupa ID -- folosita la login, inainte sa stim companyId. ID-urile sunt unice global. */
function findAgentById(agentId) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) || null;
}

function findAgentByEmail(email) {
  return db.prepare('SELECT * FROM agents WHERE email = ?').get(String(email).trim().toLowerCase()) || null;
}

function verifyAgentByEmail(email, password) {
  const agent = findAgentByEmail(email);
  if (!agent || !agent.active) return null;
  if (!verifyPassword(password, agent.passwordHash)) return null;
  const { passwordHash: _ph, password: _pw, ...safe } = agent;
  return { ...safe, active: !!safe.active };
}

function verifyAgent(agentId, password) {
  const agent = findAgentById(agentId);
  if (!agent || !agent.active) return null;
  if (!verifyPassword(password, agent.passwordHash)) return null;
  const { passwordHash: _ph, password: _pw, ...safe } = agent;
  return { ...safe, active: !!safe.active };
}

function createAgent(companyId, { name, email, password, role }) {
  if (!ALLOWED_ROLES.includes(role)) throw new Error('Rol invalid');
  const normalizedEmail = String(email).trim().toLowerCase();
  const agent = { id: genId('AGT'), companyId, name, email: normalizedEmail, role, active: 1 };
  db.prepare('INSERT INTO agents (id, companyId, name, email, passwordHash, role, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(agent.id, companyId, name, normalizedEmail, hashPassword(password), role);
  return { ...agent, active: true };
}

function updateAgent(companyId, agentId, patch) {
  const existing = findAgentById(agentId);
  if (!existing || existing.companyId !== companyId) return null;

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

function listCategories(companyId) {
  return db.prepare('SELECT name FROM categories WHERE companyId = ? ORDER BY sort_order ASC').all(companyId).map((r) => r.name);
}

function addCategory(companyId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Numele categoriei nu poate fi gol');
  const existing = db.prepare('SELECT name FROM categories WHERE companyId = ? AND name = ?').get(companyId, trimmed);
  if (existing) throw new Error('Categoria există deja');
  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM categories WHERE companyId = ?').get(companyId).m;
  db.prepare('INSERT INTO categories (companyId, name, sort_order) VALUES (?, ?, ?)').run(companyId, trimmed, (maxOrder ?? -1) + 1);
  return listCategories(companyId);
}

function removeCategory(companyId, name) {
  db.prepare('DELETE FROM categories WHERE companyId = ? AND name = ?').run(companyId, name);
  return listCategories(companyId);
}

// ---------- tichete ----------

function listTickets(companyId, filters = {}) {
  const clauses = ['companyId = ?'];
  const params = [companyId];

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

  const sql = `SELECT * FROM tickets WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy}`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToTicket);
}

function getTicket(companyId, ticketId) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  return row ? rowToTicket(row) : null;
}

function createTicket(companyId, input) {
  const ticket = {
    id: genId('TCK'),
    companyId,
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
    INSERT INTO tickets (id, companyId, subject, description, requesterName, requesterEmail, requesterPhone, category, priority, status, assignedTo, relatedOrderId, createdAt, updatedAt, resolvedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticket.id, ticket.companyId, ticket.subject, ticket.description, ticket.requesterName, ticket.requesterEmail, ticket.requesterPhone,
    ticket.category, ticket.priority, ticket.status, ticket.assignedTo, ticket.relatedOrderId,
    ticket.createdAt, ticket.updatedAt, ticket.resolvedAt
  );
  return getTicket(companyId, ticket.id);
}

function getTicketsForOrder(companyId, orderId) {
  return db.prepare('SELECT id, subject, status, priority, createdAt FROM tickets WHERE relatedOrderId = ? AND companyId = ? ORDER BY createdAt DESC').all(orderId, companyId);
}

/**
 * Salveaza AWB-ul de ridicare pe un tichet si il muta automat in sectiunea
 * corespunzatoare motivului (service/retur).
 */
const SECTION_CODE_PREFIX = { service: 'S', retur: 'R', schimb: 'CS' };

/** Atribuie urmatorul cod secvential pentru o sectiune (S-1, S-2, R-1 ...), rezervandu-l atomic. */
function nextSectionCode(companyId, section) {
  const prefix = SECTION_CODE_PREFIX[section];
  if (!prefix) return null;
  db.prepare('INSERT OR IGNORE INTO section_counters (section, nextSeq) VALUES (?, 1)').run(section);
  const row = db.prepare('SELECT nextSeq FROM section_counters WHERE section = ?').get(section);
  db.prepare('UPDATE section_counters SET nextSeq = nextSeq + 1 WHERE section = ?').run(section);
  return `${prefix}-${row.nextSeq}`;
}

/** Atribuie urmatorul cod secvential pentru o sectiune (S-1, S-2, R-1 ...), rezervandu-l atomic. */
function nextSectionCode(companyId, section) {
  const prefix = SECTION_CODE_PREFIX[section];
  if (!prefix) return null;
  db.prepare('INSERT OR IGNORE INTO section_counters (companyId, section, nextSeq) VALUES (?, ?, 1)').run(companyId, section);
  const row = db.prepare('SELECT nextSeq FROM section_counters WHERE companyId = ? AND section = ?').get(companyId, section);
  db.prepare('UPDATE section_counters SET nextSeq = nextSeq + 1 WHERE companyId = ? AND section = ?').run(companyId, section);
  return `${prefix}-${row.nextSeq}`;
}

function setTicketPickupAwb(companyId, ticketId, { awbNumber, parcelId, labelPdf, section, pickupAddress, pickupCity, pickupPostalCode, pickupPhone, courier, secondaryAwbNumber }, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  if (!ALLOWED_SECTIONS.includes(section)) throw new Error('Secțiune invalidă');

  const sectionCode = existing.sectionCode || nextSectionCode(companyId, section);
  // etapa se seteaza doar daca nu exista deja una -- altfel s-ar reseta gresit
  // la orice re-salvare (ex: re-descarcarea etichetei dupa ce marfa a ajuns deja la service)
  const stage = existing.stage || 'pickup_awb_issued';

  db.prepare(`
    UPDATE tickets SET pickupAwbNumber = ?, pickupAwbParcelId = ?, pickupAwbLabelPdf = ?, pickupAwbCreatedAt = ?, pickupAwbCourier = ?, pickupAwbSecondaryNumber = COALESCE(?, pickupAwbSecondaryNumber),
      section = ?, sectionCode = ?, stage = ?,
      pickupAddress = COALESCE(?, pickupAddress), pickupCity = COALESCE(?, pickupCity),
      pickupPostalCode = COALESCE(?, pickupPostalCode), pickupPhone = COALESCE(?, pickupPhone),
      updatedAt = ?
    WHERE id = ? AND companyId = ?
  `).run(
    awbNumber, String(parcelId), labelPdf || null, existing.pickupAwbCreatedAt || nowISO(), courier || 'gls', secondaryAwbNumber || null, section, sectionCode, stage,
    pickupAddress || null, pickupCity || null, pickupPostalCode || null, pickupPhone || null,
    nowISO(), ticketId, companyId
  );

  if (existing.section !== section) {
    logChange(companyId, ticketId, actingAgent, 'section', existing.section, section);
  }
  return getTicket(companyId, ticketId);
}

/** Sterge AWB-ul de ridicare de pe un tichet (dupa anulare la GLS). Sectiunea ramane neschimbata. */
function clearTicketPickupAwb(companyId, ticketId, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET pickupAwbNumber = NULL, pickupAwbParcelId = NULL, pickupAwbLabelPdf = NULL, pickupAwbCreatedAt = NULL, pickupAwbCourier = NULL, pickupAwbSecondaryNumber = NULL, stage = NULL, section = 'support', updatedAt = ?
    WHERE id = ? AND companyId = ?
  `).run(nowISO(), ticketId, companyId);
  if (existing.section !== 'support') {
    logChange(companyId, ticketId, actingAgent, 'section', existing.section, 'support');
  }
  return getTicket(companyId, ticketId);
}

/** Salveaza AWB-ul de retur (service -> client, dupa reparatie) si trece etapa la "in drum spre client". */
function setTicketReturnAwb(companyId, ticketId, { awbNumber, parcelId, labelPdf, courier }, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET returnAwbNumber = ?, returnAwbParcelId = ?, returnAwbLabelPdf = ?, returnAwbCreatedAt = ?, returnAwbCourier = ?,
      stage = 'return_awb_issued', updatedAt = ?
    WHERE id = ? AND companyId = ?
  `).run(awbNumber, String(parcelId), labelPdf || null, nowISO(), courier || 'gls', nowISO(), ticketId, companyId);
  logChange(companyId, ticketId, actingAgent, 'stage', existing.stage, 'return_awb_issued');
  return getTicket(companyId, ticketId);
}

/** Sterge AWB-ul de retur (dupa anulare la GLS), revenind etapa la "la service". */
function clearTicketReturnAwb(companyId, ticketId, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET returnAwbNumber = NULL, returnAwbParcelId = NULL, returnAwbLabelPdf = NULL, returnAwbCreatedAt = NULL, returnAwbCourier = NULL,
      stage = 'at_service', updatedAt = ?
    WHERE id = ? AND companyId = ?
  `).run(nowISO(), ticketId, companyId);
  return getTicket(companyId, ticketId);
}

/** Actualizeaza manual etapa unui tichet, pe baza celui mai recent status de tracking GLS primit. */
function updateTicketStage(companyId, ticketId, newStage, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  if (existing.stage === newStage) return getTicket(companyId, ticketId);
  db.prepare('UPDATE tickets SET stage = ?, updatedAt = ? WHERE id = ? AND companyId = ?').run(newStage, nowISO(), ticketId, companyId);
  logChange(companyId, ticketId, actingAgent, 'stage', existing.stage, newStage);
  return getTicket(companyId, ticketId);
}

/** Salveaza datele bancare si suma pentru rambursarea unui retur. */
function setTicketRefundInfo(companyId, ticketId, { iban, accountHolder, amount, reason }, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET refundIban = ?, refundAccountHolder = ?, refundAmount = ?, refundReason = ?, updatedAt = ?
    WHERE id = ? AND companyId = ?
  `).run(iban || null, accountHolder || null, amount != null ? Number(amount) : null, reason || null, nowISO(), ticketId, companyId);
  logChange(companyId, ticketId, actingAgent, 'refundInfo', null, `IBAN salvat, sumă ${amount || '—'}`);
  return getTicket(companyId, ticketId);
}

/** Sterge datele bancare de pe un tichet (dupa care revine automat in "In asteptare IBAN"). */
function clearTicketRefundInfo(companyId, ticketId, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tickets SET refundIban = NULL, refundAccountHolder = NULL, refundAmount = NULL, refundReason = NULL, refundPaidAt = NULL, updatedAt = ?
    WHERE id = ? AND companyId = ?
  `).run(nowISO(), ticketId, companyId);
  logChange(companyId, ticketId, actingAgent, 'refundInfo', `IBAN ${existing.refundIban || '—'}`, 'șters');
  return getTicket(companyId, ticketId);
}

/** Marcheaza un tichet ca "Bani Returnati", dupa exportul datelor bancare (individual sau in bloc). */
function markTicketRefundPaid(companyId, ticketId, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!existing) return null;
  db.prepare('UPDATE tickets SET refundPaidAt = ?, updatedAt = ? WHERE id = ? AND companyId = ?')
    .run(nowISO(), nowISO(), ticketId, companyId);
  logChange(companyId, ticketId, actingAgent, 'refundInfo', null, 'Bani returnați (marcat după export)');
  return getTicket(companyId, ticketId);
}

/** La fel, dar pentru mai multe tichete deodata (export in bloc). Ignora id-urile care nu apartin companiei. */
function markTicketsRefundPaidBulk(companyId, ticketIds, actingAgent) {
  const now = nowISO();
  const stmt = db.prepare('UPDATE tickets SET refundPaidAt = ?, updatedAt = ? WHERE id = ? AND companyId = ?');
  let marked = 0;
  db.exec('BEGIN');
  try {
    for (const ticketId of ticketIds) {
      const result = stmt.run(now, now, ticketId, companyId);
      if (result.changes > 0) {
        marked += 1;
        logChange(companyId, ticketId, actingAgent, 'refundInfo', null, 'Bani returnați (marcat după export în bloc)');
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { marked };
}

/**
 * Sterge PDF-urile de eticheta AWB salvate local (comenzi si tichete),
 * pentru orice AWB generat cu peste RETENTION_DAYS zile in urma -- pastram
 * doar numarul AWB/parcelId (mici, text), nu si continutul PDF (greu).
 * Daca cineva mai are nevoie de eticheta dupa acest interval, se re-cere
 * live de la curier (fallback deja existent in rutele de server.js) --
 * accesarea ei o re-cacheaza temporar, pana la urmatoarea curatare.
 * Ruleaza periodic, din server.js, pentru toate companiile.
 */
function purgeOldAwbLabels(retentionDays = 30) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const r1 = db.prepare(`UPDATE orders SET awbLabelPdf = NULL WHERE awbLabelPdf IS NOT NULL AND awbCreatedAt IS NOT NULL AND awbCreatedAt < ?`).run(cutoff);
  const r2 = db.prepare(`UPDATE tickets SET pickupAwbLabelPdf = NULL WHERE pickupAwbLabelPdf IS NOT NULL AND pickupAwbCreatedAt IS NOT NULL AND pickupAwbCreatedAt < ?`).run(cutoff);
  const r3 = db.prepare(`UPDATE tickets SET returnAwbLabelPdf = NULL WHERE returnAwbLabelPdf IS NOT NULL AND returnAwbCreatedAt IS NOT NULL AND returnAwbCreatedAt < ?`).run(cutoff);
  return { orders: r1.changes, ticketsPickup: r2.changes, ticketsReturn: r3.changes };
}

function updateTicket(companyId, ticketId, patch, actingAgent) {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
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
    logChange(companyId, ticketId, actingAgent, 'status', existing.status, patch.status);
  }
  if (patch.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.includes(patch.priority)) throw new Error('Prioritate invalida');
    sets.push('priority = ?'); params.push(patch.priority);
    logChange(companyId, ticketId, actingAgent, 'priority', existing.priority, patch.priority);
  }
  if (patch.category !== undefined) {
    sets.push('category = ?'); params.push(patch.category);
    logChange(companyId, ticketId, actingAgent, 'category', existing.category, patch.category);
  }
  if (patch.assignedTo !== undefined) {
    const newVal = patch.assignedTo || null;
    sets.push('assignedTo = ?'); params.push(newVal);
    const oldAgent = existing.assignedTo ? findAgentById(existing.assignedTo) : null;
    const newAgent = newVal ? findAgentById(newVal) : null;
    logChange(companyId, ticketId, actingAgent, 'assignedTo', oldAgent ? oldAgent.name : null, newAgent ? newAgent.name : null);
  }
  if (patch.subject !== undefined) { sets.push('subject = ?'); params.push(patch.subject); }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
  if (patch.section !== undefined) {
    if (!ALLOWED_SECTIONS.includes(patch.section)) throw new Error('Secțiune invalidă');
    sets.push('section = ?'); params.push(patch.section);
    logChange(companyId, ticketId, actingAgent, 'section', existing.section, patch.section);
  }

  sets.push('updatedAt = ?'); params.push(nowISO());
  params.push(ticketId, companyId);

  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ? AND companyId = ?`).run(...params);
  return getTicket(companyId, ticketId);
}

function addComment(companyId, ticketId, { authorId, authorName, body, internal }) {
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ? AND companyId = ?').get(ticketId, companyId);
  if (!ticket) return null;

  const comment = {
    id: genId('CMT'),
    companyId,
    ticketId,
    authorId,
    authorName,
    body,
    internal: internal ? 1 : 0,
    createdAt: nowISO(),
  };
  db.prepare(`
    INSERT INTO comments (id, companyId, ticketId, authorId, authorName, body, internal, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(comment.id, comment.companyId, comment.ticketId, comment.authorId, comment.authorName, comment.body, comment.internal, comment.createdAt);

  db.prepare('UPDATE tickets SET updatedAt = ? WHERE id = ? AND companyId = ?').run(nowISO(), ticketId, companyId);

  return { ...comment, internal: !!comment.internal };
}

// ---------- statistici ----------

function getStats(companyId) {
  const byStatus = {};
  ALLOWED_STATUSES.forEach((s) => (byStatus[s] = 0));
  db.prepare('SELECT status, COUNT(*) AS c FROM tickets WHERE companyId = ? GROUP BY status').all(companyId)
    .forEach((r) => { byStatus[r.status] = r.c; });

  const byPriority = {};
  ALLOWED_PRIORITIES.forEach((p) => (byPriority[p] = 0));
  db.prepare('SELECT priority, COUNT(*) AS c FROM tickets WHERE companyId = ? GROUP BY priority').all(companyId)
    .forEach((r) => { byPriority[r.priority] = r.c; });

  const byCategory = {};
  db.prepare('SELECT category, COUNT(*) AS c FROM tickets WHERE companyId = ? GROUP BY category').all(companyId)
    .forEach((r) => { byCategory[r.category] = r.c; });

  const byAgentOpenCount = {};
  db.prepare(`
    SELECT assignedTo, COUNT(*) AS c FROM tickets
    WHERE companyId = ? AND assignedTo IS NOT NULL AND status NOT IN ('resolved', 'closed')
    GROUP BY assignedTo
  `).all(companyId).forEach((r) => { byAgentOpenCount[r.assignedTo] = r.c; });

  const total = db.prepare('SELECT COUNT(*) AS c FROM tickets WHERE companyId = ?').get(companyId).c;

  const cutoffISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const resolvedToday = db.prepare('SELECT COUNT(*) AS c FROM tickets WHERE companyId = ? AND resolvedAt IS NOT NULL AND resolvedAt >= ?').get(companyId, cutoffISO).c;

  const durations = db.prepare('SELECT createdAt, resolvedAt FROM tickets WHERE companyId = ? AND resolvedAt IS NOT NULL').all(companyId)
    .map((r) => new Date(r.resolvedAt) - new Date(r.createdAt));
  const avgResolutionHours = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length / (1000 * 60 * 60)
    : null;

  const unassigned = db.prepare(`
    SELECT COUNT(*) AS c FROM tickets WHERE companyId = ? AND assignedTo IS NULL AND status NOT IN ('resolved', 'closed')
  `).get(companyId).c;

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

function upsertOrderFromMerchantPro(companyId, mp) {
  const id = `ORD_${companyId}_${mp.id}`;
  const existing = db.prepare('SELECT id, internalStatus, assignedTo, awbCourier, awbNumber, awbCreatedAt FROM orders WHERE mpId = ? AND companyId = ?').get(mp.id, companyId);

  const fields = {
    id,
    companyId,
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
      WHERE mpId = ? AND companyId = ?
    `).run(
      fields.paymentStatus, fields.paymentStatusText, fields.paymentMethodName, fields.paymentMethodCode,
      fields.shippingStatus, fields.shippingStatusText, fields.shippingMethodName, fields.shippingAwb,
      fields.totalAmount, fields.currency, fields.customerEmail, fields.billingName,
      fields.shippingName, fields.shippingCountryName, fields.shippingState, fields.shippingCity,
      fields.shippingAddress, fields.shippingPostalCode, fields.shippingPhone,
      fields.dateCreated, fields.dateModified, fields.rawJson, fields.syncedAt,
      mp.id, companyId
    );
    return { id: existing.id, isNew: false };
  }

  db.prepare(`
    INSERT INTO orders (
      id, companyId, mpId, paymentStatus, paymentStatusText, paymentMethodName, paymentMethodCode,
      shippingStatus, shippingStatusText, shippingMethodName, shippingAwb,
      totalAmount, currency, customerEmail, billingName,
      shippingName, shippingCountryName, shippingState, shippingCity,
      shippingAddress, shippingPostalCode, shippingPhone,
      dateCreated, dateModified, rawJson, internalStatus, syncedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(
    fields.id, fields.companyId, fields.mpId, fields.paymentStatus, fields.paymentStatusText, fields.paymentMethodName, fields.paymentMethodCode,
    fields.shippingStatus, fields.shippingStatusText, fields.shippingMethodName, fields.shippingAwb,
    fields.totalAmount, fields.currency, fields.customerEmail, fields.billingName,
    fields.shippingName, fields.shippingCountryName, fields.shippingState, fields.shippingCity,
    fields.shippingAddress, fields.shippingPostalCode, fields.shippingPhone,
    fields.dateCreated, fields.dateModified, fields.rawJson, fields.syncedAt
  );
  return { id, isNew: true };
}

function listOrders(companyId, filters = {}) {
  const clauses = ['companyId = ?'];
  const params = [companyId];

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

function getOrder(companyId, orderId) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ? AND companyId = ?').get(orderId, companyId);
  return row ? rowToOrder(row) : null;
}

/** Sterge o comanda locala, identificata dupa mpId (id-ul din MerchantPro). */
function deleteOrderByMpId(companyId, mpId) {
  const row = db.prepare('SELECT id FROM orders WHERE mpId = ? AND companyId = ?').get(mpId, companyId);
  if (!row) return false;
  db.prepare('DELETE FROM order_notes WHERE orderId = ?').run(row.id);
  db.prepare('UPDATE tickets SET relatedOrderId = NULL WHERE relatedOrderId = ?').run(row.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(row.id);
  return true;
}

function updateOrderInternal(companyId, orderId, patch, actingAgent) {
  const existing = db.prepare('SELECT * FROM orders WHERE id = ? AND companyId = ?').get(orderId, companyId);
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

  if (!sets.length) return getOrder(companyId, orderId);
  params.push(orderId, companyId);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND companyId = ?`).run(...params);
  return getOrder(companyId, orderId);
}

function addOrderNote(companyId, orderId, { agentId, agentName, body }) {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND companyId = ?').get(orderId, companyId);
  if (!order) return null;
  const note = { id: genId('ONT'), companyId, orderId, agentId, agentName, body, createdAt: nowISO() };
  db.prepare('INSERT INTO order_notes (id, companyId, orderId, agentId, agentName, body, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(note.id, note.companyId, note.orderId, note.agentId, note.agentName, note.body, note.createdAt);
  return note;
}

function getOrderStats(companyId, filters = {}) {
  // ---- agregari LIVE (fara filtrare de data) -- folosite pentru pastilele de status ----
  const byShippingStatus = {};
  db.prepare('SELECT shippingStatus, COUNT(*) AS c FROM orders WHERE companyId = ? GROUP BY shippingStatus').all(companyId)
    .forEach((r) => { byShippingStatus[r.shippingStatus || 'necunoscut'] = r.c; });

  const byPaymentStatus = {};
  db.prepare('SELECT paymentStatus, COUNT(*) AS c FROM orders WHERE companyId = ? GROUP BY paymentStatus').all(companyId)
    .forEach((r) => { byPaymentStatus[r.paymentStatus || 'necunoscut'] = r.c; });

  const needsAwb = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE companyId = ? AND (awbNumber IS NULL OR awbNumber = '') AND (shippingAwb IS NULL OR shippingAwb = '') AND shippingStatus NOT IN ('cancelled', 'delivered', 'returned')").get(companyId).c;
  const withAwb = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE companyId = ? AND ((awbNumber IS NOT NULL AND awbNumber != '') OR (shippingAwb IS NOT NULL AND shippingAwb != ''))").get(companyId).c;

  // ---- agregari FILTRATE pe interval de data -- folosite doar pentru cardurile de sus ----
  const dateConds = ['companyId = ?'];
  const dateParams = [companyId];
  if (filters.dateFrom) { dateConds.push('dateCreated >= ?'); dateParams.push(filters.dateFrom); }
  if (filters.dateTo) { dateConds.push('dateCreated <= ?'); dateParams.push(filters.dateTo); }
  const dateWhere = `WHERE ${dateConds.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM orders ${dateWhere}`).get(...dateParams).c;

  const byShippingStatusFiltered = {};
  db.prepare(`SELECT shippingStatus, COUNT(*) AS c FROM orders ${dateWhere} GROUP BY shippingStatus`).all(...dateParams)
    .forEach((r) => { byShippingStatusFiltered[r.shippingStatus || 'necunoscut'] = r.c; });

  const lastSync = db.prepare('SELECT MAX(syncedAt) AS t FROM orders WHERE companyId = ?').get(companyId).t;
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

/**
 * Formateaza un numar de telefon romanesc la forma canonica: 07XXXXXXXX
 * (10 cifre, incepand cu 0). Elimina orice caracter care nu e cifra
 * (apostrofuri, spatii, +, paranteze), si elimina prefixul de tara (40 sau
 * 0040), adaugand 0 la inceput daca lipseste. Daca rezultatul tot nu se
 * potriveste formatului asteptat, returneaza valoarea originala neschimbata
 * (mai bine pastram ceva, decat sa stergem o valoare pe care n-o intelegem).
 */
function formatPhoneRomanian(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/[^\d]/g, '');
  if (!digits) return null;

  if (digits.startsWith('0040')) digits = digits.slice(4);
  else if (digits.startsWith('40') && (digits.length === 11 || digits.length === 12)) digits = digits.slice(2);

  if (digits.length === 9 && !digits.startsWith('0')) digits = '0' + digits;

  return (digits.length === 10 && digits.startsWith('0')) ? digits : null;
}

function getClientProfile(companyId, { phone, email }) {
  const normPhone = normalizePhone(phone);
  const normEmail = (email || '').trim().toLowerCase() || null;
  if (!normPhone && !normEmail) return { phone: phone || null, email: email || null, orders: [], tickets: [] };

  const allOrders = db.prepare('SELECT * FROM orders WHERE companyId = ? ORDER BY dateCreated DESC').all(companyId);
  const matchedOrders = allOrders.filter((o) => {
    const p = normalizePhone(o.shippingPhone);
    const e = (o.customerEmail || '').trim().toLowerCase() || null;
    return (normPhone && p === normPhone) || (normEmail && e === normEmail);
  }).map(rowToOrder);

  const allTickets = db.prepare('SELECT * FROM tickets WHERE companyId = ? ORDER BY createdAt DESC').all(companyId);
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
function addTicketPhoto(companyId, ticketId, { dataBase64, mimeType }) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM ticket_photos WHERE ticketId = ? AND companyId = ?').get(ticketId, companyId).c;
  if (count >= MAX_TICKET_PHOTOS) throw new Error(`Limita de ${MAX_TICKET_PHOTOS} fotografii per tichet a fost atinsă.`);
  const id = genId('PHOTO');
  db.prepare('INSERT INTO ticket_photos (id, companyId, ticketId, dataBase64, mimeType, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, companyId, ticketId, dataBase64, mimeType, nowISO());
  return { id, ticketId, mimeType, createdAt: nowISO() };
}

/** Lista fotografiilor unui tichet, FARA continutul base64 (doar metadate -- pentru afisare rapida). */
function listTicketPhotos(companyId, ticketId) {
  return db.prepare('SELECT id, ticketId, mimeType, createdAt FROM ticket_photos WHERE ticketId = ? AND companyId = ? ORDER BY createdAt ASC').all(ticketId, companyId);
}

/** O fotografie completa (cu continutul base64), pentru servire directa. */
function getTicketPhoto(companyId, photoId) {
  return db.prepare('SELECT * FROM ticket_photos WHERE id = ? AND companyId = ?').get(photoId, companyId);
}

function deleteTicketPhoto(companyId, photoId) {
  const row = db.prepare('SELECT id FROM ticket_photos WHERE id = ? AND companyId = ?').get(photoId, companyId);
  if (!row) return false;
  db.prepare('DELETE FROM ticket_photos WHERE id = ?').run(photoId);
  return true;
}

module.exports.addTicketPhoto = addTicketPhoto;
module.exports.listTicketPhotos = listTicketPhotos;
module.exports.getTicketPhoto = getTicketPhoto;
module.exports.deleteTicketPhoto = deleteTicketPhoto;

// ---------- clienti importati (Excel) ----------

/** Lista PAGINATA a clientilor salvati, cu cautare optionala (nume/telefon/email). */
function listClients(companyId, { page = 1, pageSize = 100, q = '' } = {}) {
  const clauses = ['companyId = ?'];
  const params = [companyId];
  if (q && q.trim()) {
    clauses.push('(LOWER(name) LIKE ? OR phone LIKE ? OR LOWER(email) LIKE ?)');
    const like = `%${q.trim().toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS c FROM clients WHERE ${where}`).get(...params).c;
  const offset = Math.max(0, (page - 1) * pageSize);
  const items = db.prepare(`SELECT * FROM clients WHERE ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset)
    .map((r) => ({ ...r, extra: r.extraJson ? JSON.parse(r.extraJson) : null }));

  return { items, total, page, pageSize };
}

/**
 * Importa un lot de clienti (rânduri brute, deja mapate de front-end la
 * {name, phone, email, address, city, extra}). Deduplica dupa telefon
 * normalizat -- atat FATA DE CEILALTI DIN FISIER, cat si fata de clientii
 * deja salvati anterior (nu se creeaza niciodata doi clienti cu acelasi
 * telefon, in aceeasi companie). Rulat intr-o singura tranzactie -- esential
 * pentru performanta la fisiere mari (zeci de mii de randuri).
 */
function importClients(companyId, rows) {
  // INSERT OR IGNORE + constrangerea UNIQUE(companyId, phoneNormalized) deja
  // existenta pe tabela clients -- SQLite verifica duplicatele direct, prin
  // indexul sau, fara sa fie nevoie sa incarcam in memorie toti clientii deja
  // salvati (esential la scara de sute de mii -- inainte, aceasta incarcare
  // repetata, la fiecare lot trimis, a dus la epuizarea memoriei serverului).
  const ins = db.prepare(`
    INSERT OR IGNORE INTO clients (id, companyId, name, phone, phoneNormalized, email, address, city, county, extraJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let saved = 0;
  let noPhone = 0;
  let invalidPhone = 0;
  let duplicates = 0;
  const seenInFile = new Set(); // doar pt duplicate in ACELASI lot trimis -- mic, nu tot istoricul
  const savedClients = [];

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (!row.phone || !String(row.phone).trim()) { noPhone += 1; continue; }
      const formatted = formatPhoneRomanian(row.phone);
      if (!formatted) { invalidPhone += 1; continue; }
      const normalized = normalizePhone(formatted);
      if (seenInFile.has(normalized)) { duplicates += 1; continue; }
      seenInFile.add(normalized);
      const id = genId('CLI');
      const result = ins.run(
        id, companyId, row.name || null, formatted, normalized,
        row.email || null, row.address || null, row.city || null, row.county || null,
        row.extra ? JSON.stringify(row.extra) : null, nowISO()
      );
      if (result.changes > 0) {
        savedClients.push({ id, name: row.name || null, phone: formatted, email: row.email || null, address: row.address || null, city: row.city || null, county: row.county || null });
        saved += 1;
      } else {
        duplicates += 1; // exista deja in baza de date -- constrangerea UNIQUE a respins insertul
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { totalRows: rows.length, saved, duplicates, noPhone, invalidPhone, savedClients };
}

function deleteClient(companyId, clientId) {
  const row = db.prepare('SELECT id FROM clients WHERE id = ? AND companyId = ?').get(clientId, companyId);
  if (!row) return false;
  db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
  return true;
}

function deleteAllClients(companyId) {
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM clients WHERE companyId = ?').get(companyId).c;
  db.prepare('DELETE FROM clients WHERE companyId = ?').run(companyId);
  return { deletedCount: countBefore };
}

module.exports.listClients = listClients;
module.exports.importClients = importClients;
module.exports.deleteClient = deleteClient;
module.exports.deleteAllClients = deleteAllClients;

function deleteAllTickets(companyId) {
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM tickets WHERE companyId = ?').get(companyId).c;
  db.prepare('DELETE FROM tickets WHERE companyId = ?').run(companyId);
  db.prepare('DELETE FROM section_counters WHERE companyId = ?').run(companyId);
  return { deletedCount: countBefore };
}
module.exports.deleteAllTickets = deleteAllTickets;
module.exports.deleteOrderByMpId = deleteOrderByMpId;
module.exports.updateOrderInternal = updateOrderInternal;
module.exports.addOrderNote = addOrderNote;
module.exports.getOrderStats = getOrderStats;
module.exports.ALLOWED_INTERNAL_ORDER_STATUSES = ALLOWED_INTERNAL_ORDER_STATUSES;

module.exports = {
  ...module.exports,
  listAgents,
  findAgentById,
  findAgentByEmail,
  verifyAgent,
  verifyAgentByEmail,
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
  clearTicketRefundInfo,
  markTicketRefundPaid,
  markTicketsRefundPaidBulk,
  purgeOldAwbLabels,
  updateTicket,
  addComment,
  getStats,
  ALLOWED_STATUSES,
  ALLOWED_PRIORITIES,
  ALLOWED_ROLES,
  ALLOWED_SECTIONS,
  FIELD_LABELS,
};
