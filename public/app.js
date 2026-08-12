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

let currentAgent = null;
let agentsCache = [];
let categoriesCache = [];

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

window.addEventListener('hashchange', render);

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
  [agentsCache, categoriesCache] = await Promise.all([
    api('/api/agents'),
    api('/api/categories'),
  ]);
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
        <div class="nav-item nav-new" data-route="#/new"><span class="dot"></span>+ Tichet nou</div>
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
    if (route === activeRoute || (activeRoute.startsWith('#/tickets/') && route === '#/tickets')) {
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
    item.addEventListener('click', () => navigate(`#/tickets/${item.dataset.id}`));
  });
}

// ---------------- Listă tichete ----------------

function parseListRoute(hash) {
  const [, qs] = hash.split('?');
  return Object.fromEntries(new URLSearchParams(qs || ''));
}

async function renderTicketsList() {
  const filters = parseListRoute(window.location.hash);

  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Tichete</h1>
          <div class="sub">Toate solicitările clienților</div>
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
  renderShell('#/tickets', content);

  content.querySelector('#newTicketBtn').addEventListener('click', () => navigate('#/new'));

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
    navigate(`#/tickets?${params.toString()}`);
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
  const query = new URLSearchParams(filters).toString();
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
    row.addEventListener('click', () => navigate(`#/tickets/${row.dataset.id}`));
  });
}

// ---------------- Detaliu tichet ----------------

async function renderTicketDetail(ticketId) {
  const content = el(`<div id="detail-body">Se încarcă…</div>`);
  renderShell('#/tickets', content);

  let ticket;
  try {
    ticket = await api(`/api/tickets/${ticketId}`);
  } catch (e) {
    content.innerHTML = `<div class="panel">Tichetul nu a fost găsit. <a href="#/tickets" style="color:var(--accent)">Înapoi la listă</a></div>`;
    return;
  }

  function paint() {
    const comments = ticket.comments.map((c) => `
      <div class="comment">
        <div class="comment-head">
          <span class="c-author">${escapeHtml(c.authorName)}</span>
          <span class="c-time">${fmtDate(c.createdAt)}</span>
          ${c.internal ? '<span class="internal-tag">Notă internă</span>' : ''}
        </div>
        <div class="comment-body">${escapeHtml(c.body)}</div>
      </div>
    `).join('') || '<div class="panel-empty" style="color:var(--text-dim);font-size:13px;">Niciun comentariu încă.</div>';

    content.innerHTML = `
      <div class="back-link" id="backLink">← Înapoi la tichete</div>
      <div class="ticket-detail-grid">
        <div>
          <div class="ticket-header-card">
            <div class="t-id">${ticket.id}</div>
            <h1>${escapeHtml(ticket.subject)}</h1>
            <div class="badges-row">
              <span class="badge badge-status-${ticket.status}">${STATUS_LABELS[ticket.status]}</span>
              <span class="badge badge-priority-${ticket.priority}">${PRIORITY_LABELS[ticket.priority]}</span>
            </div>
            <div class="description">${escapeHtml(ticket.description)}</div>
            <div class="meta-row">
              <div class="meta-item"><div class="meta-label">Solicitant</div><div class="meta-value">${escapeHtml(ticket.requesterName)}</div></div>
              <div class="meta-item"><div class="meta-label">Email</div><div class="meta-value">${escapeHtml(ticket.requesterEmail || '—')}</div></div>
              <div class="meta-item"><div class="meta-label">Creat</div><div class="meta-value">${fmtDate(ticket.createdAt)}</div></div>
              <div class="meta-item"><div class="meta-label">Actualizat</div><div class="meta-value">${fmtDate(ticket.updatedAt)}</div></div>
            </div>
          </div>

          <div class="comments-panel">
            <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);margin:0 0 14px;">Conversație (${ticket.comments.length})</h2>
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

        <div class="side-panel">
          <h2>Gestionare tichet</h2>
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
      </div>
    `;

    content.querySelector('#backLink').addEventListener('click', () => navigate('#/tickets'));

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

function renderNewTicket() {
  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Tichet nou</h1>
          <div class="sub">Înregistrează o solicitare de suport</div>
        </div>
      </div>
      <div class="form-card">
        <form id="newForm">
          <div class="field">
            <label>Subiect *</label>
            <input type="text" id="f-subject" required placeholder="Ex: Nu pot accesa contul" />
          </div>
          <div class="field">
            <label>Descriere *</label>
            <textarea id="f-description" required placeholder="Detaliază problema semnalată de client…"></textarea>
          </div>
          <div class="form-row">
            <div class="field">
              <label>Nume solicitant *</label>
              <input type="text" id="f-reqname" required placeholder="Ex: Vlad Marinescu" />
            </div>
            <div class="field">
              <label>Email solicitant</label>
              <input type="email" id="f-reqemail" placeholder="client@exemplu.ro" />
            </div>
          </div>
          <div class="form-row">
            <div class="field">
              <label>Categorie *</label>
              <select id="f-category" required>
                ${categoriesCache.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
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
  renderShell('#/new', content);

  content.querySelector('#cancelBtn').addEventListener('click', () => navigate('#/tickets'));

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
    };
    try {
      const ticket = await api('/api/tickets', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Tichet creat cu succes');
      navigate(`#/tickets/${ticket.id}`);
    } catch (err) {
      showToast('Eroare: ' + err.message);
    }
  });
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
    renderDashboard();
  } else if (path === '#/tickets') {
    renderTicketsList();
  } else if (path === '#/new') {
    renderNewTicket();
  } else if (path.startsWith('#/tickets/')) {
    renderTicketDetail(path.replace('#/tickets/', ''));
  } else {
    navigate('#/dashboard');
  }
}

boot();
