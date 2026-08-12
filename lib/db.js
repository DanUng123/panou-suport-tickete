// Strat de persistenta bazat pe SQLite, folosind modulul NATIV al Node.js
// (node:sqlite, disponibil din Node 22.5+) -- nu necesita npm install.
//
// Baza de date traieste intr-un singur fisier pe disc: data/app.db
// Pentru gazduire pe Render/Railway etc., acest fisier trebuie sa stea pe
// un "persistent disk" / volum montat, altfel se pierde la fiecare redeploy
// (vezi README.md, sectiunea "Persistenta datelor").

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

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
    password TEXT NOT NULL,
    role TEXT NOT NULL
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

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
  CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
  CREATE INDEX IF NOT EXISTS idx_tickets_assignedTo ON tickets(assignedTo);
  CREATE INDEX IF NOT EXISTS idx_comments_ticketId ON comments(ticketId);
`);

// ---------- seed (doar la prima pornire, cand bazele sunt goale) ----------

function seedIfEmpty() {
  const agentCount = db.prepare('SELECT COUNT(*) AS c FROM agents').get().c;
  if (agentCount > 0) return; // deja populat, nu suprascriem

  if (!fs.existsSync(SEED_FILE)) return;
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));

  const insAgent = db.prepare('INSERT INTO agents (id, name, email, password, role) VALUES (?, ?, ?, ?, ?)');
  for (const a of seed.agents) insAgent.run(a.id, a.name, a.email, a.password, a.role);

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

function commentsForTicket(ticketId) {
  const rows = db.prepare('SELECT * FROM comments WHERE ticketId = ? ORDER BY createdAt ASC').all(ticketId);
  return rows.map((c) => ({ ...c, internal: !!c.internal }));
}

function rowToTicket(row) {
  if (!row) return null;
  return { ...row, comments: commentsForTicket(row.id) };
}

// ---------- agenti ----------

function listAgents() {
  return db.prepare('SELECT id, name, email, role FROM agents ORDER BY name ASC').all();
}

function findAgentById(agentId) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) || null;
}

function verifyAgent(agentId, password) {
  const agent = findAgentById(agentId);
  if (!agent) return null;
  if (agent.password !== password) return null;
  const { password: _pw, ...safe } = agent;
  return safe;
}

// ---------- categorii ----------

function listCategories() {
  return db.prepare('SELECT name FROM categories ORDER BY sort_order ASC').all().map((r) => r.name);
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
    createdAt: nowISO(),
    updatedAt: nowISO(),
    resolvedAt: null,
  };
  db.prepare(`
    INSERT INTO tickets (id, subject, description, requesterName, requesterEmail, category, priority, status, assignedTo, createdAt, updatedAt, resolvedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticket.id, ticket.subject, ticket.description, ticket.requesterName, ticket.requesterEmail,
    ticket.category, ticket.priority, ticket.status, ticket.assignedTo,
    ticket.createdAt, ticket.updatedAt, ticket.resolvedAt
  );
  return getTicket(ticket.id);
}

function updateTicket(ticketId, patch) {
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
  }
  if (patch.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.includes(patch.priority)) throw new Error('Prioritate invalida');
    sets.push('priority = ?'); params.push(patch.priority);
  }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category); }
  if (patch.assignedTo !== undefined) { sets.push('assignedTo = ?'); params.push(patch.assignedTo || null); }
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

module.exports = {
  listAgents,
  findAgentById,
  verifyAgent,
  listCategories,
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  addComment,
  getStats,
  ALLOWED_STATUSES,
  ALLOWED_PRIORITIES,
};
