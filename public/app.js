/* Panou Suport — front-end vanilla JS (fara framework), rutare pe hash. */

const app = document.getElementById('app');

const STATUS_LABELS = {
  open: 'Deschis',
  in_progress: 'În lucru',
  waiting: 'În așteptare',
  resolved: 'Rezolvat',
  closed: 'Închis',
};
const PRIORITY_LABELS = { urgent: 'Urgent', high: 'Ridicată', medium: 'Medie', low: 'Scăzută' };

const SHIPPING_STATUS_LABELS_MP = {
  awaiting: 'În așteptare', confirmed: 'Confirmată', in_process: 'În procesare',
  shipped: 'Expediată', delivered: 'Livrată', returned: 'Returnată', cancelled: 'Anulată',
};
const PAYMENT_STATUS_LABELS_MP = {
  temporary: 'Temporară', awaiting: 'În așteptare', paid: 'Plătită', failed: 'Eșuată',
  canceled: 'Anulată', refunded: 'Rambursată', rejected: 'Respinsă',
};
const INTERNAL_ORDER_STATUS_LABELS = {
  new: 'Nouă', processing: 'În lucru', awb_generated: 'AWB generat',
  shipped: 'Expediată', problem: 'Problemă', done: 'Finalizată',
};

function shippingBadgeClass(s) {
  return {
    awaiting: 'badge-status-open', confirmed: 'badge-status-in_progress', in_process: 'badge-status-in_progress',
    shipped: 'badge-status-waiting', delivered: 'badge-status-resolved', returned: 'badge-status-closed', cancelled: 'badge-priority-urgent',
  }[s] || 'badge-status-closed';
}
function paymentBadgeClass(s) {
  return {
    temporary: 'badge-status-closed', awaiting: 'badge-status-open', paid: 'badge-status-resolved',
    failed: 'badge-priority-urgent', canceled: 'badge-status-closed', refunded: 'badge-status-waiting', rejected: 'badge-priority-urgent',
  }[s] || 'badge-status-closed';
}
function internalOrderBadgeClass(s) {
  return {
    new: 'badge-status-open', processing: 'badge-status-in_progress', awb_generated: 'badge-status-waiting',
    shipped: 'badge-status-resolved', problem: 'badge-priority-urgent', done: 'badge-status-closed',
  }[s] || 'badge-status-closed';
}

let currentAgent = null;
let agentsCache = [];
let categoriesCache = [];
let glsConfigured = false;
let platformLabel = 'MERCHANTPRO';

// ---------------- utilitare ----------------

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
}

function agentName(id) {
  if (!id) return 'Neasignat';
  const a = agentsCache.find((x) => x.id === id);
  return a ? a.name : id;
}

function initials(name) {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Eroare ${res.status}`);
  }
  return data;
}

function showToast(msg) {
  const t = el(`<div class="toast">${escapeHtml(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------------- rutare ----------------

function navigate(hash) {
  window.location.hash = hash;
}

// ruta curenta afisata "sub" panoul lateral (lista din spate) -- folosita
// pentru a sti unde revenim la inchiderea panoului si pentru a evita
// re-randarea inutila a fundalului cand deja arata ce trebuie
let currentMainRoute = null;

window.addEventListener('hashchange', render);
window.addEventListener('popstate', render); // butonul Inapoi/Inainte al browserului

// ---------------- panou lateral (drawer) ----------------

function ensureDrawerEl() {
  let overlay = document.querySelector('.drawer-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.className = 'drawer-overlay';
  const panel = document.createElement('div');
  panel.className = 'drawer-panel';
  panel.id = 'drawerPanel';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeDrawer();
  });

  return overlay;
}

function openDrawer(contentNode) {
  const overlay = ensureDrawerEl();
  const panel = overlay.querySelector('#drawerPanel');
  panel.innerHTML = '';
  const closeBtn = el('<button class="drawer-close-btn" title="Închide">✕</button>');
  closeBtn.addEventListener('click', closeDrawer);
  panel.appendChild(closeBtn);
  panel.appendChild(contentNode);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function hideDrawer() {
  const overlay = document.querySelector('.drawer-overlay');
  if (overlay) overlay.classList.remove('open');
}

function closeDrawer() {
  hideDrawer();
  if (currentMainRoute) {
    history.pushState(null, '', currentMainRoute);
  }
}

async function boot() {
  try {
    currentAgent = await api('/api/session');
    await loadReferenceData();
    render();
  } catch (e) {
    renderLogin();
  }
}

async function loadReferenceData() {
  const [agents, categories, glsStatus] = await Promise.all([
    api('/api/agents'),
    api('/api/categories'),
    api('/api/gls/status').catch(() => ({ configured: false })),
  ]);
  agentsCache = agents;
  categoriesCache = categories;
  glsConfigured = glsStatus.configured;
}

// ---------------- ecran login ----------------

function renderLogin(errorMsg) {
  app.innerHTML = '';
  const card = el(`
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="mark">S</div>
          <div class="name">Panou Suport</div>
        </div>
        <h1>Autentificare agent</h1>
        <p class="sub">Selectează-ți numele și introdu parola pentru a continua.</p>
        ${errorMsg ? `<div class="error-msg">${escapeHtml(errorMsg)}</div>` : ''}
        <form id="login-form">
          <div class="field">
            <label for="agentSelect">Agent</label>
            <select id="agentSelect" required></select>
          </div>
          <div class="field">
            <label for="pw">Parolă</label>
            <input type="password" id="pw" placeholder="••••••••" required />
            <div class="hint">Demo: parola123 pentru toți agenții</div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Autentificare</button>
        </form>
      </div>
    </div>
  `);
  app.appendChild(card);

  api('/api/agents').then((agents) => {
    agentsCache = agents;
    const sel = card.querySelector('#agentSelect');
    sel.innerHTML = agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} — ${escapeHtml(a.role)}</option>`).join('');
  });

  card.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const agentId = card.querySelector('#agentSelect').value;
    const password = card.querySelector('#pw').value;
    try {
      currentAgent = await api('/api/login', { method: 'POST', body: JSON.stringify({ agentId, password }) });
      await loadReferenceData();
      navigate('#/dashboard');
      render();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  currentAgent = null;
  app.innerHTML = '';
  renderLogin();
}

// ---------------- shell (sidebar + main) ----------------

function renderShell(activeRoute, contentNode) {
  app.innerHTML = '';
  currentMainRoute = activeRoute;

  // Construim sidebar si zona principala ca doua elemente separate (nu un
  // singur bloc cu doi radacini surori) -- el() intoarce doar primul element
  // dintr-un template HTML, deci doua radacini surori ar pierde-o pe a doua.
  const sidebar = el(`
    <div class="sidebar" id="sidebar">
      <div class="brand">
        <div class="mark">S</div>
        <div class="name">Panou Suport</div>
      </div>
      <nav class="nav">
        <div class="nav-item" data-route="#/dashboard"><span class="dot"></span>Dashboard</div>
        <div class="nav-item" data-route="#/tickets"><span class="dot"></span>Tichete</div>
        <div class="nav-item" data-route="#/orders"><span class="dot"></span>Comenzi</div>
        <div class="nav-item" data-route="#/service"><span class="dot"></span>Service</div>
        <div class="nav-item" data-route="#/retur"><span class="dot"></span>Retur</div>
        ${currentAgent.role === 'manager' ? '<div class="nav-item" data-route="#/admin"><span class="dot"></span>Administrare</div>' : ''}
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="agent-card">
        <div class="avatar">${initials(currentAgent.name)}</div>
        <div class="info">
          <div class="agent-name">${escapeHtml(currentAgent.name)}</div>
          <div class="agent-role">${escapeHtml(currentAgent.role)}</div>
        </div>
        <button class="logout-btn" title="Deconectare" id="logoutBtn">⏻</button>
      </div>
    </div>
  `);
  const main = el(`<div class="main" id="main"></div>`);

  app.appendChild(sidebar);
  app.appendChild(main);

  sidebar.querySelectorAll('.nav-item').forEach((item) => {
    const route = item.dataset.route;
    if (route === activeRoute || (activeRoute.startsWith('#/tickets/') && route === '#/tickets') || (activeRoute.startsWith('#/orders/') && route === '#/orders')) {
      item.classList.add('active');
    }
    item.addEventListener('click', () => navigate(route));
  });
  sidebar.querySelector('#logoutBtn').addEventListener('click', logout);

  main.appendChild(contentNode);
  return main;
}

// ---------------- Dashboard ----------------

async function renderDashboard() {
  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Dashboard</h1>
          <div class="sub">Situația curentă a tichetelor de suport</div>
        </div>
      </div>
      <div id="dash-body">Se încarcă…</div>
    </div>
  `);
  renderShell('#/dashboard', content);

  const [stats, tickets] = await Promise.all([api('/api/stats'), api('/api/tickets?sort=priority')]);
  const body = content.querySelector('#dash-body');

  const openish = tickets.filter((t) => ['open', 'in_progress', 'waiting'].includes(t.status)).slice(0, 6);

  const maxCat = Math.max(1, ...Object.values(stats.byCategory));
  const catBars = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(cat)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(count / maxCat) * 100}%"></div></div>
        <div class="bar-count">${count}</div>
      </div>
    `).join('') || '<div class="empty">Niciun tichet încă.</div>';

  const workload = Object.entries(stats.byAgentOpenCount)
    .sort((a, b) => b[1] - a[1]);
  const maxWork = Math.max(1, ...workload.map((w) => w[1]));
  const workloadBars = workload.map(([agentId, count]) => `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(agentName(agentId))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(count / maxWork) * 100}%"></div></div>
        <div class="bar-count">${count}</div>
      </div>
  `).join('') || '<div class="empty">Nimic asignat momentan.</div>';

  const queueItems = openish.map((t) => `
    <div class="queue-item" data-id="${t.id}">
      <span class="badge badge-priority-${t.priority}">${PRIORITY_LABELS[t.priority]}</span>
      <span class="qid">${t.id.replace('TCK_', '#')}</span>
      <span class="qsubject">${escapeHtml(t.subject)}</span>
      <span class="badge badge-status-${t.status}">${STATUS_LABELS[t.status]}</span>
    </div>
  `).join('') || '<div class="empty">Coada e goală — bravo echipei!</div>';

  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile accented"><div class="label">Deschise</div><div class="value">${stats.byStatus.open}</div></div>
      <div class="stat-tile"><div class="label">În lucru</div><div class="value">${stats.byStatus.in_progress}</div></div>
      <div class="stat-tile"><div class="label">În așteptare</div><div class="value">${stats.byStatus.waiting}</div></div>
      <div class="stat-tile"><div class="label">Rezolvate azi</div><div class="value">${stats.resolvedToday}</div></div>
      <div class="stat-tile"><div class="label">Neasignate</div><div class="value">${stats.unassigned}</div></div>
      <div class="stat-tile"><div class="label">Timp mediu rezolvare</div><div class="value">${stats.avgResolutionHours ? stats.avgResolutionHours.toFixed(1) + 'h' : '—'}</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel">
        <h2>Coadă prioritară — tichete active</h2>
        <div>${queueItems}</div>
      </div>
      <div>
        <div class="panel" style="margin-bottom:16px;">
          <h2>Tichete pe categorie</h2>
          ${catBars}
        </div>
        <div class="panel">
          <h2>Volum activ pe agent</h2>
          ${workloadBars}
        </div>
      </div>
    </div>
  `;

  body.querySelectorAll('.queue-item').forEach((item) => {
    item.addEventListener('click', () => {
      history.pushState(null, '', `#/tickets/${item.dataset.id}`);
      openTicketDrawer(item.dataset.id);
    });
  });
}

// ---------------- Listă tichete ----------------

function parseListRoute(hash) {
  const [, qs] = hash.split('?');
  return Object.fromEntries(new URLSearchParams(qs || ''));
}

const SECTION_CONFIG = {
  '#/tickets': { section: 'support', title: 'Tichete', sub: 'Toate solicitările clienților' },
  '#/service': { section: 'service', title: 'Service', sub: 'Tichete cu ridicare pentru reparație/service' },
  '#/retur': { section: 'retur', title: 'Retur', sub: 'Tichete cu ridicare pentru returnare produs' },
};

async function renderTicketsList(route) {
  route = route || '#/tickets';
  const cfg = SECTION_CONFIG[route] || SECTION_CONFIG['#/tickets'];
  const filters = parseListRoute(window.location.hash);

  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>${escapeHtml(cfg.title)}</h1>
          <div class="sub">${escapeHtml(cfg.sub)}</div>
        </div>
        <button class="btn btn-primary" id="newTicketBtn">+ Tichet nou</button>
      </div>
      <div class="filters-bar">
        <input type="text" id="q" placeholder="Caută subiect, client, ID…" value="${escapeHtml(filters.q || '')}" />
        <select id="f-status">
          <option value="">Toate statusurile</option>
          ${Object.entries(STATUS_LABELS).map(([v, l]) => `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="f-priority">
          <option value="">Toate prioritățile</option>
          ${Object.entries(PRIORITY_LABELS).map(([v, l]) => `<option value="${v}" ${filters.priority === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="f-category">
          <option value="">Toate categoriile</option>
          ${categoriesCache.map((c) => `<option value="${escapeHtml(c)}" ${filters.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
        <select id="f-assigned">
          <option value="">Toți agenții</option>
          <option value="unassigned" ${filters.assignedTo === 'unassigned' ? 'selected' : ''}>Neasignat</option>
          ${agentsCache.map((a) => `<option value="${a.id}" ${filters.assignedTo === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
        </select>
      </div>
      <div id="list-body">Se încarcă…</div>
    </div>
  `);
  renderShell(route, content);

  content.querySelector('#newTicketBtn').addEventListener('click', () => openNewTicketDrawer(null));

  function applyFiltersFromForm() {
    const params = new URLSearchParams();
    const q = content.querySelector('#q').value.trim();
    const status = content.querySelector('#f-status').value;
    const priority = content.querySelector('#f-priority').value;
    const category = content.querySelector('#f-category').value;
    const assignedTo = content.querySelector('#f-assigned').value;
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (category) params.set('category', category);
    if (assignedTo) params.set('assignedTo', assignedTo);
    navigate(`${route}?${params.toString()}`);
  }

  ['#f-status', '#f-priority', '#f-category', '#f-assigned'].forEach((sel) => {
    content.querySelector(sel).addEventListener('change', applyFiltersFromForm);
  });
  let qTimer;
  content.querySelector('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(applyFiltersFromForm, 350);
  });

  const listBody = content.querySelector('#list-body');
  const query = new URLSearchParams({ ...filters, section: cfg.section }).toString();
  const tickets = await api(`/api/tickets?${query}`);

  if (!tickets.length) {
    listBody.innerHTML = `
      <div class="ticket-table">
        <div class="empty-state">
          <div class="big">◌</div>
          Niciun tichet nu corespunde filtrelor curente.
        </div>
      </div>
    `;
    return;
  }

  const rows = tickets.map((t) => `
    <div class="ticket-row" data-id="${t.id}">
      <div class="priority-stripe ${t.priority}"></div>
      <div class="ticket-id">${t.id.replace('TCK_', '#')}</div>
      <div class="ticket-subject">
        <div class="t-title">${escapeHtml(t.subject)}</div>
        <div class="t-requester">${escapeHtml(t.requesterName)}</div>
      </div>
      <div class="ticket-cat">${escapeHtml(t.category)}</div>
      <div><span class="badge badge-status-${t.status}">${STATUS_LABELS[t.status]}</span></div>
      <div class="ticket-assignee">${escapeHtml(agentName(t.assignedTo))}</div>
      <div class="ticket-date">${fmtDate(t.createdAt)}</div>
    </div>
  `).join('');

  listBody.innerHTML = `
    <div class="ticket-table">
      <div class="ticket-row header">
        <div></div><div>ID</div><div>Subiect</div><div>Categorie</div><div>Status</div><div>Agent</div><div>Creat</div>
      </div>
      ${rows}
    </div>
  `;

  listBody.querySelectorAll('.ticket-row[data-id]').forEach((row) => {
    row.addEventListener('click', () => {
      history.pushState(null, '', `#/tickets/${row.dataset.id}`);
      openTicketDrawer(row.dataset.id);
    });
  });
}

// ---------------- Detaliu tichet ----------------

/** Navigare directă (link, refresh, buton Înapoi browser) — asigură fundalul corect, apoi deschide panoul. */
async function renderTicketDetail(ticketId) {
  let ticket;
  try {
    ticket = await api(`/api/tickets/${ticketId}`);
  } catch (e) {
    if (currentMainRoute !== '#/tickets') await renderTicketsList('#/tickets');
    openDrawer(el('<div class="panel">Tichetul nu a fost găsit.</div>'));
    return;
  }
  const bgRoute = ticket.section === 'service' ? '#/service' : ticket.section === 'retur' ? '#/retur' : '#/tickets';
  if (currentMainRoute !== bgRoute) await renderTicketsList(bgRoute);
  await paintTicketDrawer(ticket);
}

/** Deschidere din click pe o listă deja afișată — fundalul rămâne neschimbat. */
async function openTicketDrawer(ticketId) {
  let ticket;
  try {
    ticket = await api(`/api/tickets/${ticketId}`);
  } catch (e) {
    showToast('Tichet negăsit');
    return;
  }
  await paintTicketDrawer(ticket);
}

async function paintTicketDrawer(ticket) {
  const content = el(`<div id="detail-body">Se încarcă…</div>`);
  openDrawer(content);

  let relatedOrder = null;
  if (ticket.relatedOrderId) {
    try { relatedOrder = await api(`/api/orders/${ticket.relatedOrderId}`); } catch (e) { /* comanda poate a fost stearsa */ }
  }

  function paint() {
    const FIELD_LABELS_RO = {
      status: 'statusul', priority: 'prioritatea', category: 'categoria', assignedTo: 'agentul asignat',
    };
    const STATUS_LABELS_MAP = STATUS_LABELS;

    function describeHistoryEntry(h) {
      const label = FIELD_LABELS_RO[h.field] || h.field;
      let oldDisplay = h.oldValue;
      let newDisplay = h.newValue;
      if (h.field === 'status') {
        oldDisplay = h.oldValue ? STATUS_LABELS_MAP[h.oldValue] : '—';
        newDisplay = h.newValue ? STATUS_LABELS_MAP[h.newValue] : '—';
      } else if (h.field === 'priority') {
        oldDisplay = h.oldValue ? PRIORITY_LABELS[h.oldValue] : '—';
        newDisplay = h.newValue ? PRIORITY_LABELS[h.newValue] : '—';
      } else if (h.field === 'assignedTo') {
        oldDisplay = h.oldValue || 'neasignat';
        newDisplay = h.newValue || 'neasignat';
      }
      return `${escapeHtml(h.agentName)} a schimbat ${label} din „${escapeHtml(String(oldDisplay))}” în „${escapeHtml(String(newDisplay))}”`;
    }

    const timelineItems = [
      ...ticket.comments.map((c) => ({ type: 'comment', createdAt: c.createdAt, data: c })),
      ...(ticket.history || []).map((h) => ({ type: 'history', createdAt: h.createdAt, data: h })),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const comments = timelineItems.map((item) => {
      if (item.type === 'history') {
        const h = item.data;
        return `
          <div class="history-entry">
            <span class="history-dot"></span>
            <span class="history-text">${describeHistoryEntry(h)}</span>
            <span class="c-time">${fmtDate(h.createdAt)}</span>
          </div>
        `;
      }
      const c = item.data;
      return `
      <div class="comment">
        <div class="comment-head">
          <span class="c-author">${escapeHtml(c.authorName)}</span>
          <span class="c-time">${fmtDate(c.createdAt)}</span>
          ${c.internal ? '<span class="internal-tag">Notă internă</span>' : ''}
        </div>
        <div class="comment-body">${escapeHtml(c.body)}</div>
      </div>
    `;
    }).join('') || '<div class="panel-empty" style="color:var(--text-dim);font-size:13px;">Niciun comentariu încă.</div>';

    content.innerHTML = `
      <div class="ticket-detail-grid" style="grid-template-columns: 1fr;">
        <div>
          <div class="ticket-header-card">
            <div class="t-id">${ticket.id}</div>
            <h1>${escapeHtml(ticket.subject)}</h1>
            <div class="badges-row">
              <span class="badge badge-status-${ticket.status}">${STATUS_LABELS[ticket.status]}</span>
              <span class="badge badge-priority-${ticket.priority}">${PRIORITY_LABELS[ticket.priority]}</span>
              ${ticket.section === 'service' ? '<span class="badge badge-status-in_progress">🔧 Service</span>' : ''}
              ${ticket.section === 'retur' ? '<span class="badge badge-priority-urgent">↩ Retur</span>' : ''}
              ${relatedOrder ? `<span class="badge badge-status-waiting" id="relatedOrderLink" style="cursor:pointer;">📦 Comandă #${relatedOrder.mpId}</span>` : ''}
            </div>
            <div class="description">${escapeHtml(ticket.description)}</div>
            <div class="meta-row">
              <div class="meta-item"><div class="meta-label">Solicitant</div><div class="meta-value">${escapeHtml(ticket.requesterName)}</div></div>
              <div class="meta-item"><div class="meta-label">Email</div><div class="meta-value">${escapeHtml(ticket.requesterEmail || '—')}</div></div>
              <div class="meta-item"><div class="meta-label">Creat</div><div class="meta-value">${fmtDate(ticket.createdAt)}</div></div>
              <div class="meta-item"><div class="meta-label">Actualizat</div><div class="meta-value">${fmtDate(ticket.updatedAt)}</div></div>
            </div>
          </div>

          <div class="side-panel" style="margin-bottom:16px;">
            <h2>Gestionare tichet</h2>
            <div class="form-row">
              <div class="side-field">
                <label>Status</label>
                <select id="sel-status">
                  ${Object.entries(STATUS_LABELS).map(([v, l]) => `<option value="${v}" ${ticket.status === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </div>
              <div class="side-field">
                <label>Prioritate</label>
                <select id="sel-priority">
                  ${Object.entries(PRIORITY_LABELS).map(([v, l]) => `<option value="${v}" ${ticket.priority === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="side-field">
                <label>Categorie</label>
                <select id="sel-category">
                  ${categoriesCache.map((c) => `<option value="${escapeHtml(c)}" ${ticket.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                </select>
              </div>
              <div class="side-field">
                <label>Agent asignat</label>
                <select id="sel-assigned">
                  <option value="">Neasignat</option>
                  ${agentsCache.map((a) => `<option value="${a.id}" ${ticket.assignedTo === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="side-field">
              <label>Secțiune</label>
              <select id="sel-section">
                <option value="support" ${ticket.section === 'support' ? 'selected' : ''}>Tichete (suport general)</option>
                <option value="service" ${ticket.section === 'service' ? 'selected' : ''}>Service</option>
                <option value="retur" ${ticket.section === 'retur' ? 'selected' : ''}>Retur</option>
              </select>
              <div class="hint" style="margin-top:6px;">Se schimbă automat la generarea unui AWB de ridicare — sau poți muta manual tichetul de aici.</div>
            </div>
          </div>

          <div class="side-panel" style="margin-bottom:16px;">
            <h2>Ridicare de la client (GLS)</h2>
            ${ticket.pickupAwbNumber ? `
              <div class="form-row">
                <div class="side-field">
                  <label>Motiv</label>
                  <div style="font-size:13px;color:var(--text);padding:8px 0;">${ticket.section === 'retur' ? 'Retur produs' : 'Service / reparație'}</div>
                </div>
                <div class="side-field">
                  <label>Număr AWB ridicare</label>
                  <div style="font-family:var(--font-mono);font-size:14px;color:var(--accent);font-weight:600;padding:8px 0;">${escapeHtml(ticket.pickupAwbNumber)}</div>
                </div>
              </div>
              <button class="btn btn-block btn-primary" id="downloadPickupLabelBtn" style="margin-bottom:8px;">↓ Descarcă eticheta PDF</button>
              <button class="btn btn-block" id="cancelPickupAwbBtn" style="color:var(--priority-urgent);">Anulează AWB ridicare</button>
            ` : `
              <form id="pickupAwbForm">
                <div class="field">
                  <label>Motiv ridicare *</label>
                  <select id="pu-reason" required>
                    <option value="service">Service / reparație</option>
                    <option value="retur">Retur produs</option>
                  </select>
                </div>
                <div class="field">
                  <label>Adresă ridicare *</label>
                  <input type="text" id="pu-address" required placeholder="Stradă, număr" value="${escapeHtml(relatedOrder?.shippingAddress || '')}" />
                </div>
                <div class="form-row">
                  <div class="field">
                    <label>Oraș *</label>
                    <input type="text" id="pu-city" required value="${escapeHtml(relatedOrder?.shippingCity || '')}" />
                  </div>
                  <div class="field">
                    <label>Cod poștal *</label>
                    <input type="text" id="pu-postal" required value="${escapeHtml(relatedOrder?.shippingPostalCode || '')}" />
                  </div>
                </div>
                <div class="field">
                  <label>Telefon client *</label>
                  <input type="text" id="pu-phone" required value="${escapeHtml(relatedOrder?.shippingPhone || '')}" />
                </div>
                ${!glsConfigured ? '<div class="hint" style="margin-bottom:10px;">Integrarea GLS nu este configurată pe server.</div>' : ''}
                <button class="btn btn-block btn-primary" type="submit" ${glsConfigured ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>Generează AWB ridicare</button>
                ${relatedOrder ? '<div class="hint" style="margin-top:8px;">Adresa a fost preluată automat din comanda asociată — o poți edita mai sus.</div>' : ''}
              </form>
            `}
          </div>

          <div class="comments-panel">
            <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);margin:0 0 14px;">Activitate (${ticket.comments.length} comentarii)</h2>
            ${comments}
            <form class="comment-form" id="commentForm">
              <textarea id="commentBody" placeholder="Scrie un răspuns sau o notă internă…" required></textarea>
              <div class="comment-form-actions">
                <label class="checkbox-label"><input type="checkbox" id="commentInternal" /> Notă internă (nu e vizibilă clientului)</label>
                <button class="btn btn-primary btn-sm" type="submit">Trimite</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;

    if (relatedOrder) {
      content.querySelector('#relatedOrderLink').addEventListener('click', () => openOrderDrawerCrossLink(relatedOrder.id));
    }

    async function patchField(field, value) {
      try {
        ticket = await api(`/api/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
        showToast('Tichet actualizat');
        paint();
      } catch (e) {
        showToast('Eroare: ' + e.message);
      }
    }

    content.querySelector('#sel-status').addEventListener('change', (e) => patchField('status', e.target.value));
    content.querySelector('#sel-priority').addEventListener('change', (e) => patchField('priority', e.target.value));
    content.querySelector('#sel-category').addEventListener('change', (e) => patchField('category', e.target.value));
    content.querySelector('#sel-assigned').addEventListener('change', (e) => patchField('assignedTo', e.target.value));
    content.querySelector('#sel-section').addEventListener('change', (e) => patchField('section', e.target.value));

    const pickupForm = content.querySelector('#pickupAwbForm');
    if (pickupForm) {
      pickupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = pickupForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Se generează…';
        const payload = {
          reason: content.querySelector('#pu-reason').value,
          address: content.querySelector('#pu-address').value.trim(),
          city: content.querySelector('#pu-city').value.trim(),
          postalCode: content.querySelector('#pu-postal').value.trim(),
          phone: content.querySelector('#pu-phone').value.trim(),
        };
        try {
          ticket = await api(`/api/tickets/${ticket.id}/generate-pickup-awb`, { method: 'POST', body: JSON.stringify(payload) });
          showToast('AWB de ridicare generat — tichetul a fost mutat');
          paint();
        } catch (err) {
          showToast('Eroare la generarea AWB: ' + err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Generează AWB ridicare';
        }
      });
    }

    const downloadPickupBtn = content.querySelector('#downloadPickupLabelBtn');
    if (downloadPickupBtn) {
      downloadPickupBtn.addEventListener('click', () => {
        window.open(`/api/tickets/${ticket.id}/pickup-awb-label`, '_blank');
      });
    }

    const cancelPickupBtn = content.querySelector('#cancelPickupAwbBtn');
    if (cancelPickupBtn) {
      cancelPickupBtn.addEventListener('click', async () => {
        if (!confirm(`Anulezi AWB-ul de ridicare ${ticket.pickupAwbNumber}? Această acțiune îl șterge și la GLS.`)) return;
        cancelPickupBtn.disabled = true;
        try {
          ticket = await api(`/api/tickets/${ticket.id}/cancel-pickup-awb`, { method: 'POST' });
          showToast('AWB de ridicare anulat');
          paint();
        } catch (err) {
          showToast('Eroare la anulare: ' + err.message);
          cancelPickupBtn.disabled = false;
        }
      });
    }

    content.querySelector('#commentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = content.querySelector('#commentBody').value.trim();
      const internal = content.querySelector('#commentInternal').checked;
      if (!body) return;
      try {
        await api(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: JSON.stringify({ body, internal }) });
        ticket = await api(`/api/tickets/${ticket.id}`);
        paint();
      } catch (err) {
        showToast('Eroare: ' + err.message);
      }
    });
  }

  paint();
}

// ---------------- Tichet nou ----------------

/** Navigare directă (link, refresh) — citește fromOrder din URL. */
async function renderNewTicket() {
  const params = parseListRoute(window.location.hash);
  if (currentMainRoute !== '#/tickets') await renderTicketsList('#/tickets');
  await paintNewTicketDrawer(params.fromOrder || null);
}

/** Deschidere din click (ex: butonul „+ Deschide tichet" de pe o comandă) — fundalul rămâne neschimbat. */
async function openNewTicketDrawer(fromOrderId) {
  history.pushState(null, '', fromOrderId ? `#/new?fromOrder=${fromOrderId}` : '#/new');
  await paintNewTicketDrawer(fromOrderId || null);
}

async function paintNewTicketDrawer(fromOrderId) {
  let prefill = null;
  if (fromOrderId) {
    try {
      const order = await api(`/api/orders/${fromOrderId}`);
      const itemsList = (order.lineItems || [])
        .map((it) => `- ${it.product_name || '—'} × ${it.quantity ?? 1}${it.product_sku ? ` (${it.product_sku})` : ''}`)
        .join('\n');
      prefill = {
        subject: `Comandă #${order.mpId} — `,
        description:
`Comandă MerchantPro #${order.mpId}
Status livrare: ${SHIPPING_STATUS_LABELS_MP[order.shippingStatus] || order.shippingStatus || '—'} | Status plată: ${PAYMENT_STATUS_LABELS_MP[order.paymentStatus] || order.paymentStatus || '—'}

Produse:
${itemsList || '(niciun produs listat)'}

Adresă livrare: ${order.shippingAddress || '—'}, ${order.shippingCity || ''}, ${order.shippingState || ''} ${order.shippingPostalCode || ''}, ${order.shippingCountryName || ''}
Telefon: ${order.shippingPhone || '—'}

—
`,
        requesterName: order.shippingName || order.billingName || '',
        requesterEmail: order.customerEmail || '',
        orderId: order.id,
        orderMpId: order.mpId,
      };
    } catch (e) {
      showToast('Nu am putut încărca datele comenzii: ' + e.message);
    }
  }

  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Tichet nou</h1>
          <div class="sub">${prefill ? `Creat din comanda #${prefill.orderMpId}` : 'Înregistrează o solicitare de suport'}</div>
        </div>
      </div>
      ${prefill ? `<div class="hint" style="margin-bottom:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">📦 Informațiile clientului și ale comenzii au fost preluate automat mai jos — poți edita orice câmp înainte de a salva.</div>` : ''}
      <div class="form-card" style="max-width:100%;">
        <form id="newForm">
          <div class="field">
            <label>Subiect *</label>
            <input type="text" id="f-subject" required placeholder="Ex: Nu pot accesa contul" value="${prefill ? escapeHtml(prefill.subject) : ''}" />
          </div>
          <div class="field">
            <label>Descriere *</label>
            <textarea id="f-description" required placeholder="Detaliază problema semnalată de client…">${prefill ? escapeHtml(prefill.description) : ''}</textarea>
          </div>
          <div class="form-row">
            <div class="field">
              <label>Nume solicitant *</label>
              <input type="text" id="f-reqname" required placeholder="Ex: Vlad Marinescu" value="${prefill ? escapeHtml(prefill.requesterName) : ''}" />
            </div>
            <div class="field">
              <label>Email solicitant</label>
              <input type="email" id="f-reqemail" placeholder="client@exemplu.ro" value="${prefill ? escapeHtml(prefill.requesterEmail) : ''}" />
            </div>
          </div>
          <div class="form-row">
            <div class="field">
              <label>Categorie *</label>
              <select id="f-category" required>
                ${categoriesCache.map((c) => `<option value="${escapeHtml(c)}" ${prefill && c === 'Livrare' ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Prioritate</label>
              <select id="f-priority">
                ${Object.entries(PRIORITY_LABELS).map(([v, l]) => `<option value="${v}" ${v === 'medium' ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field">
            <label>Asignează agentului</label>
            <select id="f-assigned">
              <option value="">Neasignat</option>
              ${agentsCache.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Creează tichet</button>
            <button class="btn btn-ghost" type="button" id="cancelBtn">Anulează</button>
          </div>
        </form>
      </div>
    </div>
  `);
  openDrawer(content);

  content.querySelector('#cancelBtn').addEventListener('click', () => closeDrawer());

  content.querySelector('#newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      subject: content.querySelector('#f-subject').value.trim(),
      description: content.querySelector('#f-description').value.trim(),
      requesterName: content.querySelector('#f-reqname').value.trim(),
      requesterEmail: content.querySelector('#f-reqemail').value.trim(),
      category: content.querySelector('#f-category').value,
      priority: content.querySelector('#f-priority').value,
      assignedTo: content.querySelector('#f-assigned').value || null,
      relatedOrderId: prefill ? prefill.orderId : null,
    };
    try {
      const ticket = await api('/api/tickets', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Tichet creat cu succes');
      if (currentMainRoute !== '#/tickets') await renderTicketsList('#/tickets');
      history.pushState(null, '', `#/tickets/${ticket.id}`);
      await paintTicketDrawer(await api(`/api/tickets/${ticket.id}`));
    } catch (err) {
      showToast('Eroare: ' + err.message);
    }
  });
}

// ---------------- Comenzi (MerchantPro) ----------------

function fmtMoney(amount, currency) {
  if (amount === null || amount === undefined) return '—';
  return `${Number(amount).toFixed(2)} ${currency || ''}`.trim();
}

async function renderOrdersList() {
  const filters = parseListRoute(window.location.hash);

  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Comenzi</h1>
          <div class="sub">Sincronizate din MerchantPro</div>
        </div>
        <button class="btn btn-primary" id="syncNowBtn">↻ Sincronizează acum</button>
      </div>
      <div id="sync-banner"></div>
      <div class="stat-grid" id="order-stats" style="margin-bottom:18px;"></div>
      <div class="filters-bar">
        <input type="text" id="q" placeholder="Caută client, oraș, ID comandă…" value="${escapeHtml(filters.q || '')}" />
        <select id="f-shipping">
          <option value="">Toate statusurile livrare</option>
          ${Object.entries(SHIPPING_STATUS_LABELS_MP).map(([v, l]) => `<option value="${v}" ${filters.shippingStatus === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="f-payment">
          <option value="">Toate statusurile plată</option>
          ${Object.entries(PAYMENT_STATUS_LABELS_MP).map(([v, l]) => `<option value="${v}" ${filters.paymentStatus === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="f-internal">
          <option value="">Toate statusurile interne</option>
          ${Object.entries(INTERNAL_ORDER_STATUS_LABELS).map(([v, l]) => `<option value="${v}" ${filters.internalStatus === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="f-assigned">
          <option value="">Toți agenții</option>
          <option value="unassigned" ${filters.assignedTo === 'unassigned' ? 'selected' : ''}>Neasignat</option>
          ${agentsCache.map((a) => `<option value="${a.id}" ${filters.assignedTo === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
        </select>
        <label class="checkbox-label"><input type="checkbox" id="f-needsawb" ${filters.needsAwb === '1' ? 'checked' : ''} /> Fără AWB</label>
      </div>
      <div id="orders-body">Se încarcă…</div>
    </div>
  `);
  renderShell('#/orders', content);

  // status sincronizare
  try {
    const syncStatus = await api('/api/orders/sync-status');
    platformLabel = syncStatus.platformLabel || 'MERCHANTPRO';
    const banner = content.querySelector('#sync-banner');
    if (!syncStatus.configured) {
      banner.innerHTML = `<div class="panel" style="margin-bottom:16px;border-color:var(--priority-high);">
        <strong style="color:var(--priority-high);">Integrarea MerchantPro nu e configurată.</strong>
        <div style="color:var(--text-secondary);font-size:12.5px;margin-top:4px;">Adaugă variabilele de mediu MERCHANTPRO_SHOP_URL, MERCHANTPRO_API_KEY, MERCHANTPRO_API_SECRET pe server.</div>
      </div>`;
    } else if (syncStatus.lastSyncResult) {
      const r = syncStatus.lastSyncResult;
      banner.innerHTML = `<div style="color:var(--text-dim);font-size:12px;margin-bottom:14px;">Ultima sincronizare: ${fmtDate(r.at)} · ${r.created} noi, ${r.updated} actualizate</div>`;
    }
  } catch (e) { /* n-o afisam ca eroare blocanta */ }

  content.querySelector('#syncNowBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Se sincronizează…';
    try {
      await api('/api/orders/sync', { method: 'POST' });
      showToast('Sincronizare finalizată');
      renderOrdersList();
    } catch (err) {
      showToast('Eroare: ' + err.message);
      e.target.disabled = false;
      e.target.textContent = '↻ Sincronizează acum';
    }
  });

  // statistici
  try {
    const stats = await api('/api/orders/stats');
    content.querySelector('#order-stats').innerHTML = `
      <div class="stat-tile accented"><div class="label">Total comenzi</div><div class="value">${stats.total}</div></div>
      <div class="stat-tile"><div class="label">Fără AWB</div><div class="value">${stats.needsAwb}</div></div>
      ${Object.entries(stats.byShippingStatus).map(([s, c]) => `<div class="stat-tile"><div class="label">${escapeHtml(SHIPPING_STATUS_LABELS_MP[s] || s)}</div><div class="value">${c}</div></div>`).join('')}
    `;
  } catch (e) { /* n-o afisam ca eroare blocanta */ }

  function applyFiltersFromForm() {
    const params = new URLSearchParams();
    const q = content.querySelector('#q').value.trim();
    const shippingStatus = content.querySelector('#f-shipping').value;
    const paymentStatus = content.querySelector('#f-payment').value;
    const internalStatus = content.querySelector('#f-internal').value;
    const assignedTo = content.querySelector('#f-assigned').value;
    const needsAwb = content.querySelector('#f-needsawb').checked;
    if (q) params.set('q', q);
    if (shippingStatus) params.set('shippingStatus', shippingStatus);
    if (paymentStatus) params.set('paymentStatus', paymentStatus);
    if (internalStatus) params.set('internalStatus', internalStatus);
    if (assignedTo) params.set('assignedTo', assignedTo);
    if (needsAwb) params.set('needsAwb', '1');
    navigate(`#/orders?${params.toString()}`);
  }
  ['#f-shipping', '#f-payment', '#f-internal', '#f-assigned', '#f-needsawb'].forEach((sel) => {
    content.querySelector(sel).addEventListener('change', applyFiltersFromForm);
  });
  let qTimer;
  content.querySelector('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(applyFiltersFromForm, 350);
  });

  const listBody = content.querySelector('#orders-body');
  const apiFilters = { ...filters };
  const query = new URLSearchParams(apiFilters).toString();
  let orders;
  try {
    orders = await api(`/api/orders?${query}`);
  } catch (e) {
    listBody.innerHTML = `<div class="panel">Eroare la încărcarea comenzilor: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (!orders.length) {
    listBody.innerHTML = `
      <div class="ticket-table">
        <div class="empty-state">
          <div class="big">◌</div>
          Nicio comandă nu corespunde filtrelor curente (sau nu a rulat încă nicio sincronizare).
        </div>
      </div>
    `;
    return;
  }

  const rows = orders.map((o) => {
    const thumbs = (o.lineItems || []).slice(0, 3).map((it) => it.product_image_url
      ? `<img class="order-thumb" src="${escapeHtml(it.product_image_url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'order-thumb order-thumb-placeholder',textContent:'—'}))" />`
      : `<div class="order-thumb order-thumb-placeholder">—</div>`).join('');
    const extraCount = (o.lineItems || []).length - 3;

    return `
    <div class="order-row" data-id="${o.id}">
      <div class="order-platform"><span class="platform-dot"></span>${escapeHtml(platformLabel)}</div>
      <div class="order-id">#${o.mpId}</div>
      <div class="order-client">
        <div class="t-title">${escapeHtml(o.shippingName || o.billingName || '—')}</div>
        <div class="t-requester">${escapeHtml(o.shippingCity || '')}</div>
      </div>
      <div class="order-thumbs">${thumbs}${extraCount > 0 ? `<div class="order-thumb order-thumb-more">+${extraCount}</div>` : ''}</div>
      <div class="order-total">${fmtMoney(o.totalAmount, o.currency)}</div>
      <div><span class="badge badge-status-closed">${escapeHtml(o.paymentMethodName || '—')}</span></div>
      <div><span class="badge ${shippingBadgeClass(o.shippingStatus)}">${SHIPPING_STATUS_LABELS_MP[o.shippingStatus] || o.shippingStatus || '—'}</span></div>
      <div class="order-invoice">—</div>
      <div class="ticket-date">${fmtDate(o.dateCreated)}</div>
    </div>
  `;
  }).join('');

  listBody.innerHTML = `
    <div class="ticket-table">
      <div class="order-row header">
        <div>Platformă</div><div>Comandă</div><div>Client</div><div>Produse</div><div>Total</div><div>Metodă</div><div>Livrare</div><div>Factură</div><div>Data</div>
      </div>
      ${rows}
    </div>
  `;
  listBody.querySelectorAll('.order-row[data-id]').forEach((row) => {
    row.addEventListener('click', () => {
      history.pushState(null, '', `#/orders/${row.dataset.id}`);
      openOrderDrawer(row.dataset.id);
    });
  });
}

/** Navigare directă (link, refresh, buton Înapoi browser). */
async function renderOrderDetail(orderId) {
  if (currentMainRoute !== '#/orders') await renderOrdersList();
  await openOrderDrawer(orderId);
}

/** Deschidere din click pe o listă deja afișată — fundalul rămâne neschimbat. */
async function openOrderDrawer(orderId) {
  let order;
  try {
    order = await api(`/api/orders/${orderId}`);
  } catch (e) {
    openDrawer(el('<div class="panel">Comanda nu a fost găsită.</div>'));
    return;
  }

  const content = el(`<div id="order-detail-body">Se încarcă…</div>`);
  openDrawer(content);

  let linkedTickets = [];
  try {
    linkedTickets = await api(`/api/orders/${orderId}/tickets`);
  } catch (e) { /* nu blocam afisarea comenzii pentru asta */ }

  function paint() {
    const items = (order.lineItems || []).map((it) => `
      <div class="line-item-row">
        ${it.product_image_url
          ? `<img class="li-thumb" src="${escapeHtml(it.product_image_url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'li-thumb li-thumb-placeholder',textContent:'—'}))" />`
          : `<div class="li-thumb li-thumb-placeholder">—</div>`}
        <div class="li-name">${escapeHtml(it.product_name || '—')}${it.product_sku ? ` <span style="color:var(--text-dim);">(${escapeHtml(it.product_sku)})</span>` : ''}</div>
        <div class="li-qty">× ${it.quantity ?? 1}</div>
        <div class="li-price">${fmtMoney(it.line_subtotal_gross ?? it.unit_price_gross, order.currency)}</div>
      </div>
    `).join('') || '<div style="color:var(--text-dim);font-size:13px;">Niciun produs listat.</div>';

    const notes = order.notes.map((n) => `
      <div class="comment">
        <div class="comment-head">
          <span class="c-author">${escapeHtml(n.agentName)}</span>
          <span class="c-time">${fmtDate(n.createdAt)}</span>
        </div>
        <div class="comment-body">${escapeHtml(n.body)}</div>
      </div>
    `).join('') || '<div style="color:var(--text-dim);font-size:13px;">Nicio notiță încă.</div>';

    const linkedTicketsHtml = linkedTickets.map((t) => `
      <div class="queue-item" data-tid="${t.id}">
        <span class="badge badge-priority-${t.priority}">${PRIORITY_LABELS[t.priority]}</span>
        <span class="qid">${t.id.replace('TCK_', '#')}</span>
        <span class="qsubject">${escapeHtml(t.subject)}</span>
        <span class="badge badge-status-${t.status}">${STATUS_LABELS[t.status]}</span>
      </div>
    `).join('');

    content.innerHTML = `
      <div class="ticket-detail-grid" style="grid-template-columns: 1fr;">
        <div>
          <div class="ticket-header-card">
            <div class="t-id" style="display:flex;align-items:center;justify-content:space-between;">
              <span>Comandă MerchantPro #${order.mpId}</span>
              <button class="btn btn-sm btn-primary" id="openTicketBtn">+ Deschide tichet</button>
            </div>
            <h1>${escapeHtml(order.shippingName || order.billingName || '—')}</h1>
            <div class="badges-row">
              <span class="badge ${paymentBadgeClass(order.paymentStatus)}">${PAYMENT_STATUS_LABELS_MP[order.paymentStatus] || order.paymentStatus || '—'}</span>
              <span class="badge ${shippingBadgeClass(order.shippingStatus)}">${SHIPPING_STATUS_LABELS_MP[order.shippingStatus] || order.shippingStatus || '—'}</span>
              <span class="badge ${internalOrderBadgeClass(order.internalStatus)}">${INTERNAL_ORDER_STATUS_LABELS[order.internalStatus] || order.internalStatus}</span>
            </div>
            <div class="meta-row" style="margin-top:2px;padding-top:0;border-top:none;">
              <div class="meta-item"><div class="meta-label">Email</div><div class="meta-value">${escapeHtml(order.customerEmail || '—')}</div></div>
              <div class="meta-item"><div class="meta-label">Telefon</div><div class="meta-value">${escapeHtml(order.shippingPhone || '—')}</div></div>
              <div class="meta-item"><div class="meta-label">Total</div><div class="meta-value">${fmtMoney(order.totalAmount, order.currency)}</div></div>
              <div class="meta-item"><div class="meta-label">Creată</div><div class="meta-value">${fmtDate(order.dateCreated)}</div></div>
            </div>
            <div class="meta-row">
              <div class="meta-item" style="flex:1;">
                <div class="meta-label">Adresă livrare</div>
                <div class="meta-value">${escapeHtml(order.shippingAddress || '—')}, ${escapeHtml(order.shippingCity || '')}, ${escapeHtml(order.shippingState || '')} ${escapeHtml(order.shippingPostalCode || '')}, ${escapeHtml(order.shippingCountryName || '')}</div>
              </div>
            </div>
            ${linkedTickets.length ? `
              <div class="meta-row" style="flex-direction:column;align-items:stretch;">
                <div class="meta-label" style="margin-bottom:8px;">Tichete asociate (${linkedTickets.length})</div>
                ${linkedTicketsHtml}
              </div>
            ` : ''}
          </div>

          <div class="side-panel" style="margin-bottom:16px;">
            <h2>Gestionare comandă</h2>
            <div class="form-row">
              <div class="side-field">
                <label>Status intern</label>
                <select id="sel-internal">
                  ${Object.entries(INTERNAL_ORDER_STATUS_LABELS).map(([v, l]) => `<option value="${v}" ${order.internalStatus === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </div>
              <div class="side-field">
                <label>Agent responsabil</label>
                <select id="sel-assigned">
                  <option value="">Neasignat</option>
                  ${agentsCache.map((a) => `<option value="${a.id}" ${order.assignedTo === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
                </select>
              </div>
            </div>
          </div>

          <div class="side-panel" style="margin-bottom:16px;">
            <h2>Livrare / AWB</h2>
            ${order.awbNumber ? `
              <div class="form-row">
                <div class="side-field">
                  <label>Curier</label>
                  <div style="font-size:13px;color:var(--text);padding:8px 0;">${escapeHtml(order.awbCourier || 'GLS')}</div>
                </div>
                <div class="side-field">
                  <label>Număr AWB</label>
                  <div style="font-family:var(--font-mono);font-size:14px;color:var(--accent);font-weight:600;padding:8px 0;">${escapeHtml(order.awbNumber)}</div>
                </div>
              </div>
              <button class="btn btn-block btn-primary" id="downloadLabelBtn" style="margin-bottom:8px;">↓ Descarcă eticheta PDF</button>
              <button class="btn btn-block" id="cancelAwbBtn" style="color:var(--priority-urgent);">Anulează AWB</button>
            ` : `
              <div class="form-row">
                <div class="side-field">
                  <label>Curier</label>
                  <select disabled title="Doar GLS momentan">
                    <option>GLS</option>
                  </select>
                </div>
                <div class="side-field">
                  <label>Număr AWB</label>
                  <input type="text" disabled placeholder="Nu a fost generat încă" style="width:100%;background:var(--surface-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text-dim);" />
                </div>
              </div>
              <button class="btn btn-block ${glsConfigured ? 'btn-primary' : ''}" id="generateAwbBtn" ${glsConfigured ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;" title="Configurează integrarea GLS pentru a activa"'}>Generează AWB</button>
              ${glsConfigured
                ? '<div class="hint" style="margin-top:10px;">Prima generare de AWB pentru firma ta — verifică cu atenție rezultatul.</div>'
                : '<div class="hint" style="margin-top:10px;">Emiterea AWB prin GLS va fi activă după configurarea credențialelor API GLS pe server.</div>'}
            `}
            ${order.shippingAwb && !order.awbNumber ? `<div class="hint" style="margin-top:8px;">AWB existent în MerchantPro: <strong style="color:var(--text);">${escapeHtml(order.shippingAwb)}</strong></div>` : ''}
          </div>

          <div class="comments-panel" style="margin-bottom:16px;">
            <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);margin:0 0 14px;">Produse comandate</h2>
            <div class="line-items-list">${items}</div>
          </div>

          <div class="comments-panel">
            <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);margin:0 0 14px;">Notițe interne (${order.notes.length})</h2>
            ${notes}
            <form class="comment-form" id="noteForm">
              <textarea id="noteBody" placeholder="Adaugă o notiță pentru echipă…" required></textarea>
              <div class="comment-form-actions" style="justify-content:flex-end;">
                <button class="btn btn-primary btn-sm" type="submit">Adaugă notiță</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;

    content.querySelector('#openTicketBtn').addEventListener('click', () => openNewTicketDrawer(order.id));
    content.querySelectorAll('.queue-item[data-tid]').forEach((item) => {
      item.addEventListener('click', () => openTicketDrawerCrossLink(item.dataset.tid));
    });

    async function patchOrder(field, value) {
      try {
        order = await api(`/api/orders/${order.id}`, { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
        showToast('Comandă actualizată');
        paint();
      } catch (e) {
        showToast('Eroare: ' + e.message);
      }
    }
    content.querySelector('#sel-internal').addEventListener('change', (e) => patchOrder('internalStatus', e.target.value));
    content.querySelector('#sel-assigned').addEventListener('change', (e) => patchOrder('assignedTo', e.target.value));

    const generateBtn = content.querySelector('#generateAwbBtn');
    if (generateBtn && glsConfigured) {
      generateBtn.addEventListener('click', async () => {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Se generează…';
        try {
          order = await api(`/api/orders/${order.id}/generate-awb`, { method: 'POST' });
          showToast('AWB generat cu succes');
          paint();
        } catch (err) {
          showToast('Eroare la generarea AWB: ' + err.message);
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generează AWB';
        }
      });
    }

    const downloadBtn = content.querySelector('#downloadLabelBtn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        window.open(`/api/orders/${order.id}/awb-label`, '_blank');
      });
    }

    const cancelBtn = content.querySelector('#cancelAwbBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        if (!confirm(`Anulezi AWB-ul ${order.awbNumber}? Această acțiune îl șterge și la GLS.`)) return;
        cancelBtn.disabled = true;
        try {
          order = await api(`/api/orders/${order.id}/cancel-awb`, { method: 'POST' });
          showToast('AWB anulat');
          paint();
        } catch (err) {
          showToast('Eroare la anularea AWB: ' + err.message);
          cancelBtn.disabled = false;
        }
      });
    }

    content.querySelector('#noteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = content.querySelector('#noteBody').value.trim();
      if (!body) return;
      try {
        await api(`/api/orders/${order.id}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
        order = await api(`/api/orders/${order.id}`);
        paint();
      } catch (err) {
        showToast('Eroare: ' + err.message);
      }
    });
  }

  paint();
}

/** Deschide tichetul asociat unei comenzi, comutând fundalul la lista de tichete corectă. */
async function openTicketDrawerCrossLink(ticketId) {
  let ticket;
  try { ticket = await api(`/api/tickets/${ticketId}`); } catch (e) { showToast('Tichet negăsit'); return; }
  const bgRoute = ticket.section === 'service' ? '#/service' : ticket.section === 'retur' ? '#/retur' : '#/tickets';
  if (currentMainRoute !== bgRoute) await renderTicketsList(bgRoute);
  history.pushState(null, '', `#/tickets/${ticketId}`);
  await paintTicketDrawer(ticket);
}

/** Deschide comanda asociată unui tichet, comutând fundalul la lista de comenzi. */
async function openOrderDrawerCrossLink(orderId) {
  if (currentMainRoute !== '#/orders') await renderOrdersList();
  history.pushState(null, '', `#/orders/${orderId}`);
  await openOrderDrawer(orderId);
}

// ---------------- Administrare (doar manageri) ----------------

async function renderAdmin() {
  if (currentAgent.role !== 'manager') {
    navigate('#/dashboard');
    return;
  }

  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Administrare</h1>
          <div class="sub">Gestionează agenții și categoriile de tichete</div>
        </div>
      </div>
      <div class="admin-tabs">
        <button class="admin-tab active" data-tab="agents">Agenți</button>
        <button class="admin-tab" data-tab="categories">Categorii</button>
      </div>
      <div id="admin-body">Se încarcă…</div>
    </div>
  `);
  renderShell('#/admin', content);

  let activeTab = 'agents';
  const body = content.querySelector('#admin-body');

  content.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      content.querySelectorAll('.admin-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      paintTab();
    });
  });

  async function paintTab() {
    if (activeTab === 'agents') await paintAgents();
    else await paintCategories();
  }

  async function paintAgents() {
    body.innerHTML = 'Se încarcă…';
    let agents;
    try {
      agents = await api('/api/admin/agents');
    } catch (e) {
      body.innerHTML = `<div class="panel">Eroare: ${escapeHtml(e.message)}</div>`;
      return;
    }

    const rows = agents.map((a) => `
      <div class="admin-row" data-id="${a.id}">
        <div class="admin-row-main">
          <div class="admin-row-name">${escapeHtml(a.name)} ${!a.active ? '<span class="badge badge-status-closed">Inactiv</span>' : ''}</div>
          <div class="admin-row-sub">${escapeHtml(a.email)} · ${a.role === 'manager' ? 'Manager' : 'Agent'}</div>
        </div>
        <div class="admin-row-actions">
          <button class="btn btn-sm btn-ghost edit-agent-btn" data-id="${a.id}">Editează</button>
        </div>
      </div>
      <div class="admin-edit-panel" id="edit-${a.id}" style="display:none;"></div>
    `).join('');

    body.innerHTML = `
      <div class="panel" style="margin-bottom:16px;">
        <h2>Agent nou</h2>
        <form id="newAgentForm" class="admin-inline-form">
          <input type="text" id="na-name" placeholder="Nume" required />
          <input type="email" id="na-email" placeholder="Email" required />
          <input type="password" id="na-password" placeholder="Parolă (min. 6 caractere)" required minlength="6" />
          <select id="na-role">
            <option value="agent">Agent</option>
            <option value="manager">Manager</option>
          </select>
          <button class="btn btn-primary btn-sm" type="submit">+ Adaugă</button>
        </form>
      </div>
      <div class="panel">
        <h2>Agenți existenți (${agents.length})</h2>
        ${rows}
      </div>
    `;

    body.querySelector('#newAgentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: body.querySelector('#na-name').value.trim(),
        email: body.querySelector('#na-email').value.trim(),
        password: body.querySelector('#na-password').value,
        role: body.querySelector('#na-role').value,
      };
      try {
        await api('/api/admin/agents', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Agent adăugat');
        agentsCache = await api('/api/agents');
        paintAgents();
      } catch (err) {
        showToast('Eroare: ' + err.message);
      }
    });

    body.querySelectorAll('.edit-agent-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const panel = body.querySelector(`#edit-${id}`);
        const agent = agents.find((a) => a.id === id);
        const isOpen = panel.style.display !== 'none';
        body.querySelectorAll('.admin-edit-panel').forEach((p) => (p.style.display = 'none'));
        if (isOpen) return;
        panel.style.display = 'block';
        panel.innerHTML = `
          <form class="admin-inline-form edit-form">
            <input type="text" class="ea-name" value="${escapeHtml(agent.name)}" placeholder="Nume" />
            <input type="email" class="ea-email" value="${escapeHtml(agent.email)}" placeholder="Email" />
            <input type="password" class="ea-password" placeholder="Parolă nouă (opțional)" minlength="6" />
            <select class="ea-role">
              <option value="agent" ${agent.role === 'agent' ? 'selected' : ''}>Agent</option>
              <option value="manager" ${agent.role === 'manager' ? 'selected' : ''}>Manager</option>
            </select>
            <label class="checkbox-label"><input type="checkbox" class="ea-active" ${agent.active ? 'checked' : ''} /> Activ</label>
            <button class="btn btn-primary btn-sm" type="submit">Salvează</button>
          </form>
        `;
        panel.querySelector('.edit-form').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const payload = {
            name: panel.querySelector('.ea-name').value.trim(),
            email: panel.querySelector('.ea-email').value.trim(),
            role: panel.querySelector('.ea-role').value,
            active: panel.querySelector('.ea-active').checked,
          };
          const newPw = panel.querySelector('.ea-password').value;
          if (newPw) payload.password = newPw;
          try {
            await api(`/api/admin/agents/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
            showToast('Agent actualizat');
            agentsCache = await api('/api/agents');
            paintAgents();
          } catch (err) {
            showToast('Eroare: ' + err.message);
          }
        });
      });
    });
  }

  async function paintCategories() {
    body.innerHTML = 'Se încarcă…';
    let categories;
    try {
      categories = await api('/api/categories');
    } catch (e) {
      body.innerHTML = `<div class="panel">Eroare: ${escapeHtml(e.message)}</div>`;
      return;
    }

    const rows = categories.map((c) => `
      <div class="admin-row">
        <div class="admin-row-main"><div class="admin-row-name">${escapeHtml(c)}</div></div>
        <div class="admin-row-actions">
          <button class="btn btn-sm btn-ghost delete-cat-btn" data-name="${escapeHtml(c)}">Șterge</button>
        </div>
      </div>
    `).join('');

    body.innerHTML = `
      <div class="panel" style="margin-bottom:16px;">
        <h2>Categorie nouă</h2>
        <form id="newCatForm" class="admin-inline-form">
          <input type="text" id="nc-name" placeholder="Nume categorie" required />
          <button class="btn btn-primary btn-sm" type="submit">+ Adaugă</button>
        </form>
      </div>
      <div class="panel">
        <h2>Categorii existente (${categories.length})</h2>
        ${rows}
      </div>
    `;

    body.querySelector('#newCatForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = body.querySelector('#nc-name').value.trim();
      try {
        await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
        showToast('Categorie adăugată');
        categoriesCache = await api('/api/categories');
        paintCategories();
      } catch (err) {
        showToast('Eroare: ' + err.message);
      }
    });

    body.querySelectorAll('.delete-cat-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Ștergi categoria „${btn.dataset.name}”? Tichetele existente care o folosesc nu sunt afectate.`)) return;
        try {
          await api(`/api/categories/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
          showToast('Categorie ștearsă');
          categoriesCache = await api('/api/categories');
          paintCategories();
        } catch (err) {
          showToast('Eroare: ' + err.message);
        }
      });
    });
  }

  paintTab();
}

// ---------------- router principal ----------------

function render() {
  if (!currentAgent) {
    renderLogin();
    return;
  }
  const hash = window.location.hash || '#/dashboard';
  const path = hash.split('?')[0];

  if (path === '#/dashboard' || hash === '') {
    hideDrawer();
    renderDashboard();
  } else if (path === '#/tickets') {
    hideDrawer();
    renderTicketsList('#/tickets');
  } else if (path === '#/service') {
    hideDrawer();
    renderTicketsList('#/service');
  } else if (path === '#/retur') {
    hideDrawer();
    renderTicketsList('#/retur');
  } else if (path === '#/orders') {
    hideDrawer();
    renderOrdersList();
  } else if (path === '#/new') {
    renderNewTicket();
  } else if (path === '#/admin') {
    hideDrawer();
    renderAdmin();
  } else if (path.startsWith('#/tickets/')) {
    renderTicketDetail(path.replace('#/tickets/', ''));
  } else if (path.startsWith('#/orders/')) {
    renderOrderDetail(path.replace('#/orders/', ''));
  } else {
    navigate('#/dashboard');
  }
}

boot();
