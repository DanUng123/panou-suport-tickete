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
let isPlatformAdmin = false; // adevarat doar daca s-a logat prin poarta separata #/platform-admin
let agentsCache = [];
let categoriesCache = [];
let glsConfigured = false;
let samedayConfigured = false;
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

function fmtShortDate(date) {
  if (!date) return '—';
  return date.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' });
}

/** Etichete pentru "Unde e marfa" — text simplu, contextual pe secțiune (service/retur). */
/** Eticheta pentru coloana STATUS (badge) — poate diferi de "unde e marfa" (ex: AWB emis, dar marfa tot la client). */
function stageStatusLabel(stage, section) {
  if (section === 'schimb') {
    const map = {
      pickup_awb_issued: 'AWB emis',
      in_transit_to_service: 'In drum spre client',
      at_service: 'Colet livrat',
    };
    return map[stage] || 'Neridicat încă';
  }
  const isRetur = section === 'retur';
  const map = {
    pickup_awb_issued: 'AWB de ridicare emis',
    in_transit_to_service: isRetur ? 'În drum spre depozit' : 'În drum spre service',
    at_service: isRetur ? 'La depozit' : 'La service',
    return_awb_issued: 'AWB de retur emis',
    in_transit_to_client: 'În drum spre client',
    delivered_to_client: 'Livrat la client',
  };
  return map[stage] || 'Neridicat încă';
}

/** Statusul AWB-ului RETUR, la Colet la Schimb (ridicarea produsului vechi de la client) — independent de statusul AWB-ului tur. */
function stageSecondaryStatusLabel(secondaryStage, hasSecondaryAwb) {
  if (!hasSecondaryAwb) return '—';
  const map = {
    awb_issued: 'AWB emis',
    picked_up: 'Schimb Ridicate',
    delivered: 'Schimb Livrat',
  };
  return map[secondaryStage] || 'AWB emis';
}

function stageSecondaryDotColor(secondaryStage) {
  const map = {
    awb_issued: 'var(--status-open)',
    picked_up: 'var(--status-in_progress)',
    delivered: 'var(--status-resolved)',
  };
  return map[secondaryStage] || 'var(--status-open)';
}

/** Eticheta pentru coloana "Unde e marfa" — locația fizică reală, nu statusul AWB-ului. */
function stageLocationLabel(stage, section) {
  if (section === 'schimb') {
    const map = {
      pickup_awb_issued: 'La client',
      in_transit_to_service: 'Curier în drum (schimb)',
      at_service: 'Schimb efectuat',
    };
    return map[stage] || 'Neridicat încă';
  }
  const isRetur = section === 'retur';
  const map = {
    pickup_awb_issued: 'La client',
    in_transit_to_service: isRetur ? 'În drum spre depozit' : 'În drum spre service',
    at_service: isRetur ? 'La depozit' : 'La service',
    return_awb_issued: 'La service',
    in_transit_to_client: 'În drum spre client',
    delivered_to_client: 'La client',
  };
  return map[stage] || 'Neridicat încă';
}

function stageDotColor(stage) {
  const map = {
    pickup_awb_issued: 'var(--status-open)',
    in_transit_to_service: 'var(--status-in_progress)',
    at_service: 'var(--status-waiting)',
    return_awb_issued: 'var(--status-open)',
    in_transit_to_client: 'var(--status-in_progress)',
    delivered_to_client: 'var(--status-resolved)',
  };
  return map[stage] || 'var(--text-dim)';
}

/** Termenul de 7 zile, calculat de la generarea AWB-ului de ridicare. */
function computeDeadline(ticket) {
  if (!ticket.pickupAwbCreatedAt) return null;
  const d = new Date(ticket.pickupAwbCreatedAt);
  d.setDate(d.getDate() + 7);
  return d;
}

function isPastDeadline(ticket) {
  const deadline = computeDeadline(ticket);
  if (!deadline) return false;
  const isFinished = ticket.status === 'resolved' || ticket.status === 'closed';
  return !isFinished && new Date() > deadline;
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

// Mai multe evenimente de schimbare a adresei pot surveni foarte apropiat in
// timp (ex: o redirectionare interna care schimba adresa de doua ori la rand
// -- vezi renderOrdersList). Fara aceasta amanare, fiecare ar declansa propria
// randare completa, suprapunandu-se -- exact cauza incarcarii vizibil mai
// lente, resimtite la fiecare click. Colectam toate declansarile foarte
// apropiate intr-una singura, care citeste adresa finala, curenta.
let renderDebounceHandle = null;
function scheduleRender() {
  if (renderDebounceHandle !== null) clearTimeout(renderDebounceHandle);
  renderDebounceHandle = setTimeout(() => {
    renderDebounceHandle = null;
    render();
  }, 0);
}
window.addEventListener('hashchange', scheduleRender);
window.addEventListener('popstate', scheduleRender); // butonul Inapoi/Inainte al browserului

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
  const closeBar = el(`
    <div class="drawer-close-bar">
      <button class="drawer-close-btn" title="Închide">✕</button>
    </div>
  `);
  closeBar.querySelector('.drawer-close-btn').addEventListener('click', closeDrawer);
  panel.appendChild(closeBar);
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
    render(); // reimprospatam lista de dedesubt -- un tichet poate fi ajuns intre timp intr-un alt tab (schimbare de status/etapa in panou)
  }
}

// ---------------- Fereastra modala (centrata, distincta de panoul lateral) ----------------

function ensureModalEl() {
  let overlay = document.querySelector('.modal-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal-box';
  box.id = 'modalBox';
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
  });

  return overlay;
}

function openModal(contentNode, { title, onClose, restoreHistory = true } = {}) {
  const overlay = ensureModalEl();
  const box = overlay.querySelector('#modalBox');
  box.innerHTML = '';
  box._onClose = onClose || null;
  box._restoreHistory = restoreHistory;
  const header = el(`
    <div class="modal-header">
      <h2>${escapeHtml(title || '')}</h2>
      <button class="modal-close-btn" title="Închide">✕</button>
    </div>
  `);
  header.querySelector('.modal-close-btn').addEventListener('click', closeModal);
  box.appendChild(header);
  box.appendChild(contentNode);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closeModal() {
  const overlay = document.querySelector('.modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  const box = overlay.querySelector('#modalBox');
  if (box && box._onClose) box._onClose();
  if (box && box._restoreHistory !== false && currentMainRoute) {
    history.pushState(null, '', currentMainRoute);
  }
}

async function boot() {
  try {
    currentAgent = await api('/api/session');
    isPlatformAdmin = Boolean(currentAgent.isPlatformAdmin);
    await loadReferenceData();
    render();
  } catch (e) {
    currentAgent = null;
    isPlatformAdmin = false;
    render();
  }
}

async function loadReferenceData() {
  const [agents, categories, glsStatus, samedayStatus] = await Promise.all([
    api('/api/agents'),
    api('/api/categories'),
    api('/api/gls/status').catch(() => ({ configured: false })),
    api('/api/sameday/status').catch(() => ({ configured: false })),
  ]);
  agentsCache = agents;
  categoriesCache = categories;
  glsConfigured = glsStatus.configured;
  samedayConfigured = samedayStatus.configured;
}

// ---------------- ecran login ----------------

// ---------------- Pagini publice (marketing) — inainte de autentificare ----------------

const MARKETING_NAV_LINKS = [
  { route: '#/acasa', label: 'Acasă' },
  { route: '#/ce-este', label: 'Ce este' },
  { route: '#/preturi', label: 'Prețuri' },
  { route: '#/despre', label: 'Despre' },
  { route: '#/contact', label: 'Contact' },
];

function renderMarketingShell(activeRoute, innerHtml) {
  app.innerHTML = '';
  const page = el(`
    <div style="min-height:100vh;width:100%;display:flex;flex-direction:column;background:var(--bg);">
      <header style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:18px 32px;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" id="marketingLogo">
          <div style="width:32px;height:32px;border-radius:8px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;">S</div>
          <div style="font-weight:700;font-size:16px;">SuportMaster</div>
        </div>
        <nav style="display:flex;gap:4px;flex-wrap:wrap;">
          ${MARKETING_NAV_LINKS.map((l) => `<a href="${l.route}" class="marketing-nav-link" data-route="${l.route}" style="padding:8px 14px;border-radius:6px;font-size:13.5px;text-decoration:none;color:${activeRoute === l.route ? 'var(--text)' : 'var(--text-secondary)'};background:${activeRoute === l.route ? 'var(--surface-raised)' : 'transparent'};">${l.label}</a>`).join('')}
        </nav>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-sm" id="marketingLoginBtn">Autentificare</button>
          <button class="btn btn-sm btn-primary" id="marketingSignupBtn">Creează cont</button>
        </div>
      </header>
      <main style="flex:1;">${innerHtml}</main>
      <footer style="border-top:1px solid var(--border);padding:28px 32px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;color:var(--text-dim);font-size:12.5px;">
        <div>© ${new Date().getFullYear()} SuportMaster. Toate drepturile rezervate.</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          ${MARKETING_NAV_LINKS.map((l) => `<a href="${l.route}" class="marketing-nav-link" data-route="${l.route}" style="color:var(--text-dim);text-decoration:none;">${l.label}</a>`).join('')}
        </div>
      </footer>
    </div>
  `);
  app.appendChild(page);

  page.querySelector('#marketingLogo').addEventListener('click', () => navigate('#/acasa'));
  page.querySelector('#marketingLoginBtn').addEventListener('click', () => navigate('#/login'));
  page.querySelector('#marketingSignupBtn').addEventListener('click', () => navigate('#/signup'));
  page.querySelectorAll('.marketing-nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.dataset.route);
    });
  });
  return page;
}

function renderMarketingHome() {
  renderMarketingShell('#/acasa', `
    <section style="max-width:920px;margin:0 auto;padding:80px 24px 60px;text-align:center;">
      <div style="display:inline-block;padding:6px 14px;border-radius:20px;background:var(--surface-raised);color:var(--accent);font-size:12.5px;font-weight:600;margin-bottom:20px;">Platformă pentru magazine online din România</div>
      <h1 style="font-size:40px;line-height:1.15;margin-bottom:16px;">Suport clienți, comenzi și curieri — totul dintr-un singur loc</h1>
      <p style="font-size:16px;color:var(--text-secondary);max-width:640px;margin:0 auto 32px;">SuportMaster unește tichetele de service, retur și schimb, sincronizarea automată a comenzilor din MerchantPro, și generarea AWB-urilor cu GLS și Sameday — într-o singură platformă, gândită pentru echipe reale.</p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-primary" id="heroSignupBtn" style="padding:12px 24px;font-size:14.5px;">Creează cont gratuit</button>
        <button class="btn" id="heroPricingBtn" style="padding:12px 24px;font-size:14.5px;">Vezi prețurile</button>
      </div>
    </section>

    <section style="max-width:1080px;margin:0 auto;padding:20px 24px 80px;">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;">
        ${[
          { icon: '🎫', title: 'Tichete Service, Retur, Schimb', desc: 'Fiecare tip de solicitare are propriul flux, cu etape urmărite automat, de la ridicare până la finalizare.' },
          { icon: '📦', title: 'Curieri conectați direct', desc: 'AWB-uri generate și urmărite automat prin GLS și Sameday, fără să părăsești platforma.' },
          { icon: '🔄', title: 'Comenzi sincronizate din MerchantPro', desc: 'Comenzile intră automat, la interval regulat, fără introducere manuală.' },
          { icon: '👥', title: 'Multi-companie, izolat complet', desc: 'Fiecare firmă are datele ei separate — perfect pentru echipe sau clienți multipli.' },
        ].map((f) => `
          <div class="panel">
            <div style="font-size:26px;margin-bottom:10px;">${f.icon}</div>
            <div style="font-weight:600;margin-bottom:6px;">${f.title}</div>
            <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">${f.desc}</div>
          </div>
        `).join('')}
      </div>
    </section>

    <section style="text-align:center;padding:20px 24px 90px;">
      <h2 style="font-size:24px;margin-bottom:12px;">Gata să simplifici procesul de suport?</h2>
      <p style="color:var(--text-secondary);margin-bottom:24px;">Pornește gratuit — devii automat manager pe contul companiei tale.</p>
      <button class="btn btn-primary" id="ctaSignupBtn" style="padding:12px 24px;font-size:14.5px;">Creează cont gratuit</button>
    </section>
  `);
  document.getElementById('heroSignupBtn').addEventListener('click', () => navigate('#/signup'));
  document.getElementById('heroPricingBtn').addEventListener('click', () => navigate('#/preturi'));
  document.getElementById('ctaSignupBtn').addEventListener('click', () => navigate('#/signup'));
}

function renderMarketingWhatIs() {
  const sections = [
    { title: 'Tichete de suport, pe trei fluxuri dedicate', body: 'Service, Retur și Colet la Schimb au fiecare propriul flux — de la generarea AWB-ului de ridicare, până la finalizare. Etapele se actualizează automat, pe baza statusului real de la curier, sau manual, când e nevoie.' },
    { title: 'Curieri integrați direct — GLS și Sameday', body: 'Generezi eticheta, urmărești traseul, descarci PDF-ul — totul din tichet, fără să deschizi panoul curierului separat. La Colet la Schimb, ambele AWB-uri (tur și retur) sunt urmărite independent.' },
    { title: 'Comenzi sincronizate automat din MerchantPro', body: 'Comenzile magazinului tău intră automat în platformă, la interval regulat, cu tot ce ai nevoie: status plată, status livrare, produse, sumă.' },
    { title: 'Rambursări gestionate complet', body: 'Datele bancare (IBAN, titular, sumă) se colectează direct pe tichet, cu validare automată. Etichetele se generează individual sau în bloc, pentru mai multe tichete deodată.' },
    { title: 'Bază de clienți, cu import din Excel', body: 'Încarci un fișier Excel cu clienți, platforma elimină automat duplicatele (după telefon) și normalizează formatele — pregătit pentru volume mari, de sute de mii de rânduri.' },
    { title: 'Multi-companie, de la prima zi', body: 'Fiecare companie își gestionează propriii agenți, tichete, comenzi și credențiale de curier — complet izolat de restul companiilor de pe platformă.' },
  ];
  renderMarketingShell('#/ce-este', `
    <section style="max-width:760px;margin:0 auto;padding:60px 24px;">
      <h1 style="font-size:32px;margin-bottom:12px;">Ce este SuportMaster</h1>
      <p style="color:var(--text-secondary);margin-bottom:40px;font-size:15px;">O platformă construită special pentru echipele de suport ale magazinelor online — unde tichetele, comenzile și curierii lucrează împreună, nu separat.</p>
      ${sections.map((s) => `
        <div style="margin-bottom:32px;padding-bottom:32px;border-bottom:1px solid var(--border);">
          <h2 style="font-size:18px;margin-bottom:8px;">${s.title}</h2>
          <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;">${s.body}</p>
        </div>
      `).join('')}
    </section>
  `);
}

function renderMarketingPricing() {
  const plans = [
    {
      name: 'Start', price: '100', popular: false,
      features: ['Până la 2 agenți', 'Un curier conectat (GLS sau Sameday)', 'Tichete nelimitate', 'Sincronizare comenzi MerchantPro', 'Suport prin email'],
    },
    {
      name: 'Business', price: '200', popular: true,
      features: ['Până la 5 agenți', 'Ambii curieri (GLS + Sameday)', 'Tichete și comenzi nelimitate', 'Gestionare rambursări (IBAN)', 'Import/export clienți din Excel', 'Suport prioritar'],
    },
    {
      name: 'Enterprise', price: '300', popular: false,
      features: ['Agenți nelimitați', 'Ambii curieri, plus prioritate la sincronizare', 'Import clienți la volum mare (sute de mii)', 'Export în bloc, date bancare', 'Suport dedicat, cu timp de răspuns garantat'],
    },
  ];
  renderMarketingShell('#/preturi', `
    <section style="max-width:1080px;margin:0 auto;padding:60px 24px;">
      <div style="text-align:center;margin-bottom:48px;">
        <h1 style="font-size:32px;margin-bottom:12px;">Prețuri simple, fără costuri ascunse</h1>
        <p style="color:var(--text-secondary);font-size:15px;">Alege planul potrivit pentru mărimea echipei tale. Poți schimba planul oricând.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;align-items:start;">
        ${plans.map((p) => `
          <div class="panel" style="${p.popular ? 'border-color:var(--accent);position:relative;' : ''}">
            ${p.popular ? '<div style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:11px;font-weight:600;padding:4px 12px;border-radius:12px;">Cel mai popular</div>' : ''}
            <div style="font-weight:600;font-size:16px;margin-bottom:4px;">${p.name}</div>
            <div style="margin-bottom:16px;"><span style="font-size:32px;font-weight:700;">${p.price}</span> <span style="color:var(--text-secondary);font-size:13px;">RON/lună</span></div>
            <ul style="list-style:none;padding:0;margin:0 0 20px;display:flex;flex-direction:column;gap:10px;">
              ${p.features.map((f) => `<li style="font-size:13px;color:var(--text-secondary);display:flex;gap:8px;align-items:flex-start;"><span style="color:var(--status-resolved);">✓</span>${f}</li>`).join('')}
            </ul>
            <button class="btn ${p.popular ? 'btn-primary' : ''} btn-block plan-signup-btn">Alege ${p.name}</button>
          </div>
        `).join('')}
      </div>
    </section>
  `);
  document.querySelectorAll('.plan-signup-btn').forEach((btn) => btn.addEventListener('click', () => navigate('#/signup')));
}

function renderMarketingAbout() {
  renderMarketingShell('#/despre', `
    <section style="max-width:720px;margin:0 auto;padding:60px 24px;">
      <h1 style="font-size:32px;margin-bottom:20px;">Despre SuportMaster</h1>
      <p style="color:var(--text-secondary);font-size:15px;line-height:1.7;margin-bottom:20px;">SuportMaster s-a născut dintr-o nevoie simplă: echipele care gestionează suportul clienților pentru magazine online lucrează în prea multe locuri deodată — un panou pentru tichete, altul pentru curieri, altul pentru comenzi. Am construit o singură platformă care le aduce pe toate laolaltă.</p>
      <p style="color:var(--text-secondary);font-size:15px;line-height:1.7;margin-bottom:20px;">Fiecare funcționalitate a platformei — de la urmărirea automată a AWB-urilor, până la gestionarea rambursărilor — a plecat de la un proces real, folosit zilnic de o echipă de suport, nu de la o listă abstractă de funcții.</p>
      <p style="color:var(--text-secondary);font-size:15px;line-height:1.7;">Platforma e construită pentru magazine online din România, cu integrări directe către curierii și platforma de eCommerce pe care le folosești deja.</p>
    </section>
  `);
}

function renderMarketingContact() {
  const page = renderMarketingShell('#/contact', `
    <section style="max-width:560px;margin:0 auto;padding:60px 24px;">
      <h1 style="font-size:32px;margin-bottom:12px;">Contact</h1>
      <p style="color:var(--text-secondary);font-size:14.5px;margin-bottom:32px;">Ai o întrebare despre platformă? Scrie-ne — revenim cât mai curând.</p>
      <form id="contactForm">
        <div class="field">
          <label>Nume</label>
          <input type="text" id="contactName" required />
        </div>
        <div class="field">
          <label>Email</label>
          <input type="email" id="contactEmail" required />
        </div>
        <div class="field">
          <label>Mesaj</label>
          <textarea id="contactMessage" style="min-height:120px;" required></textarea>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Trimite mesajul</button>
        <div id="contactResult" style="margin-top:14px;"></div>
      </form>
    </section>
  `);

  page.querySelector('#contactForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = page.querySelector('button[type="submit"]');
    const resultBox = page.querySelector('#contactResult');
    const payload = {
      name: page.querySelector('#contactName').value.trim(),
      email: page.querySelector('#contactEmail').value.trim(),
      message: page.querySelector('#contactMessage').value.trim(),
    };
    btn.disabled = true;
    btn.textContent = 'Se trimite…';
    try {
      await api('/api/public/contact', { method: 'POST', body: JSON.stringify(payload) });
      resultBox.innerHTML = `<div class="hint" style="background:rgba(107,196,130,0.1);border:1px solid rgba(107,196,130,0.3);border-radius:8px;padding:10px 12px;">✓ Mesaj trimis — revenim cât mai curând.</div>`;
      page.querySelector('#contactForm').reset();
    } catch (err) {
      resultBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Trimite mesajul';
    }
  });
}

// ---------------- Panoul de administrare al platformei (creatorul platformei) ----------------
// Complet separat de autentificarea normala de agent/companie -- propria
// sesiune, propriul cookie, propria parola (din PLATFORM_ADMIN_PASSWORD).

async function renderPlatformAdminGate() {
  // daca esti deja logat (ca admin platforma SAU ca agent normal), du-te direct in aplicatie
  if (currentAgent) {
    window.location.hash = '#/dashboard';
    render();
    return;
  }
  try {
    currentAgent = await api('/api/session');
    isPlatformAdmin = Boolean(currentAgent.isPlatformAdmin);
    if (isPlatformAdmin) {
      await loadReferenceData();
      window.location.hash = '#/dashboard';
      render();
      return;
    }
  } catch (e) { /* nu esti logat inca -- aratam poarta de mai jos */ }
  renderPlatformAdminLogin();
}

function renderPlatformAdminLogin(errorMsg) {
  app.innerHTML = '';
  const card = el(`
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="mark">⚙</div>
          <div class="name">Administrare Platformă</div>
        </div>
        <h1>Autentificare</h1>
        <p class="sub">Acces rezervat creatorului platformei — te duce direct în aplicația completă.</p>
        ${errorMsg ? `<div class="error-msg">${escapeHtml(errorMsg)}</div>` : ''}
        <form id="platform-admin-login-form">
          <div class="field">
            <label for="paPassword">Parolă</label>
            <input type="password" id="paPassword" placeholder="••••••••" required autofocus />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Autentificare</button>
        </form>
      </div>
    </div>
  `);
  app.appendChild(card);

  card.querySelector('#platform-admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = card.querySelector('#paPassword').value;
    try {
      currentAgent = await api('/api/platform-admin/login', { method: 'POST', body: JSON.stringify({ password }) });
      isPlatformAdmin = true;
      await loadReferenceData();
      window.location.hash = '#/dashboard';
      render();
    } catch (err) {
      renderPlatformAdminLogin(err.message);
    }
  });
}

async function renderPlatformAdminPanel() {
  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Administrare Platformă</h1>
          <div class="sub">Toate companiile de pe platformă — activează sau dezactivează accesul oricăreia dintre ele.</div>
        </div>
      </div>
      <div class="panel">
        <div id="companiesListArea">Se încarcă…</div>
      </div>
    </div>
  `);
  renderShell('#/administrare-platforma', content);

  async function loadCompanies() {
    const listArea = content.querySelector('#companiesListArea');
    try {
      const companies = await api('/api/platform-admin/companies');
      if (!companies.length) {
        listArea.innerHTML = '<div class="hint">Nicio companie înregistrată încă.</div>';
        return;
      }
      const headerHtml = `
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0 8px;border-bottom:2px solid var(--border);font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.03em;">
          <div style="flex:1.5;min-width:0;">Companie</div>
          <div style="flex:1;min-width:0;">Înregistrată</div>
          <div style="flex:0.7;min-width:0;">Agenți</div>
          <div style="flex:0.8;min-width:0;">Status</div>
          <div style="flex-shrink:0;width:110px;"></div>
        </div>
      `;
      const rowsHtml = companies.map((c) => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;">
          <div style="flex:1.5;min-width:0;font-weight:500;">${escapeHtml(c.name)}${c.isTestAccount ? ' <span class="badge" style="background:rgba(47,111,237,0.15);color:var(--accent);font-size:10.5px;">contul tău</span>' : ''}</div>
          <div style="flex:1;min-width:0;color:var(--text-secondary);">${escapeHtml(fmtDate(c.createdAt))}</div>
          <div style="flex:0.7;min-width:0;color:var(--text-secondary);">${c.agentCount}</div>
          <div style="flex:0.8;min-width:0;">
            <span class="badge" style="background:${c.active ? 'rgba(107,196,130,0.18)' : 'rgba(232,92,76,0.18)'};color:${c.active ? 'var(--status-resolved)' : 'var(--priority-urgent)'};">${c.active ? '✓ Activă' : '✕ Dezactivată'}</span>
          </div>
          ${c.isTestAccount
            ? '<div style="flex-shrink:0;width:110px;font-size:11px;color:var(--text-dim);">protejat</div>'
            : `<button class="btn btn-sm company-toggle-btn" data-id="${c.id}" data-active="${c.active}" style="flex-shrink:0;width:110px;${c.active ? 'color:var(--priority-urgent);' : 'color:var(--status-resolved);'}">${c.active ? 'Dezactivează' : 'Activează'}</button>`}
        </div>
      `).join('');
      listArea.innerHTML = '';
      listArea.appendChild(el(`<div>${headerHtml}${rowsHtml}</div>`));

      listArea.querySelectorAll('.company-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const isActive = btn.dataset.active === 'true';
          const newActive = !isActive;
          const label = newActive ? 'activezi' : 'dezactivezi';
          if (!confirm(`Ești sigur că ${label} această companie? ${!newActive ? 'Toți agenții ei vor fi deconectați imediat și nu se vor mai putea autentifica.' : ''}`)) return;
          btn.disabled = true;
          try {
            await api(`/api/platform-admin/companies/${btn.dataset.id}/active`, { method: 'POST', body: JSON.stringify({ active: newActive }) });
            showToast(newActive ? 'Companie activată' : 'Companie dezactivată');
            loadCompanies();
          } catch (e) {
            showToast('Eroare: ' + e.message);
            btn.disabled = false;
          }
        });
      });
    } catch (e) {
      listArea.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }
  loadCompanies();
}

async function renderPlatformClientsPanel() {
  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Clienți (toate companiile)</h1>
          <div class="sub">Clienți unici, agregați din comenzile tuturor companiilor de pe platformă — deduplicați după telefon.</div>
        </div>
      </div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
          <h2 style="margin:0;">Total clienți unici (<span id="platformClientsCount">…</span>)</h2>
          <button class="btn btn-sm" id="platformClientsExportBtn">↓ Descarcă toți</button>
        </div>
        <input type="text" id="platformClientsSearchInput" placeholder="Caută după nume, telefon sau email…" style="width:100%;margin-bottom:12px;background:var(--surface-raised);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:13px;color:var(--text);" />
        <div id="platformClientsListArea">Se încarcă…</div>
        <div id="platformClientsPager" style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:16px;"></div>
      </div>
    </div>
  `);
  renderShell('#/administrare-platforma-clienti', content);

  let currentPage = 1;
  const pageSize = 100;
  let searchTimer = null;

  async function loadClients() {
    const listArea = content.querySelector('#platformClientsListArea');
    const pagerArea = content.querySelector('#platformClientsPager');
    const countSpan = content.querySelector('#platformClientsCount');
    const q = content.querySelector('#platformClientsSearchInput').value.trim();
    try {
      const params = new URLSearchParams({ page: currentPage, pageSize, q });
      const { items, total } = await api(`/api/platform-admin/clients?${params.toString()}`);
      countSpan.textContent = total;
      if (!total) {
        listArea.innerHTML = q ? '<div class="hint">Niciun client găsit pentru această căutare.</div>' : '<div class="hint">Niciun client încă — apare automat pe măsură ce companiile primesc comenzi.</div>';
        pagerArea.innerHTML = '';
        return;
      }
      const headerHtml = `
        <div style="display:flex;align-items:center;gap:12px;padding:6px 0 8px;border-bottom:2px solid var(--border);font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.03em;">
          <div style="flex:1.2;min-width:0;">Nume</div>
          <div style="flex:1.4;min-width:0;">Adresă</div>
          <div style="flex:0.9;min-width:0;">Oraș</div>
          <div style="flex:0.7;min-width:0;">Județ</div>
          <div style="flex:1;min-width:0;">Telefon</div>
          <div style="flex:1.2;min-width:0;">Email</div>
        </div>
      `;
      const rowsHtml = items.map((c) => `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
          <div style="flex:1.2;min-width:0;font-weight:500;">${escapeHtml(c.name || '—')}</div>
          <div style="flex:1.4;min-width:0;color:var(--text-secondary);">${escapeHtml(c.address || '—')}</div>
          <div style="flex:0.9;min-width:0;color:var(--text-secondary);">${escapeHtml(c.city || '—')}</div>
          <div style="flex:0.7;min-width:0;color:var(--text-secondary);">${escapeHtml(c.county || '—')}</div>
          <div style="flex:1;min-width:0;font-family:var(--font-mono);color:var(--text-secondary);">${escapeHtml(c.phone || '—')}</div>
          <div style="flex:1.2;min-width:0;color:var(--text-secondary);">${escapeHtml(c.email || '—')}</div>
        </div>
      `).join('');
      listArea.innerHTML = '';
      listArea.appendChild(el(`<div>${headerHtml}${rowsHtml}</div>`));

      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      pagerArea.innerHTML = '';
      pagerArea.appendChild(el(`
        <div style="display:flex;align-items:center;gap:12px;">
          <button class="btn btn-sm" id="platformClientsPrevPage" ${currentPage <= 1 ? 'disabled' : ''}>← Anterioară</button>
          <span class="hint">Pagina ${currentPage} din ${totalPages}</span>
          <button class="btn btn-sm" id="platformClientsNextPage" ${currentPage >= totalPages ? 'disabled' : ''}>Următoare →</button>
        </div>
      `));
      const prevBtn = pagerArea.querySelector('#platformClientsPrevPage');
      const nextBtn = pagerArea.querySelector('#platformClientsNextPage');
      if (prevBtn) prevBtn.addEventListener('click', () => { currentPage -= 1; loadClients(); });
      if (nextBtn) nextBtn.addEventListener('click', () => { currentPage += 1; loadClients(); });
    } catch (e) {
      listArea.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }
  loadClients();

  content.querySelector('#platformClientsSearchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentPage = 1;
      loadClients();
    }, 350);
  });

  content.querySelector('#platformClientsExportBtn').addEventListener('click', async () => {
    const btn = content.querySelector('#platformClientsExportBtn');
    btn.disabled = true;
    const EXPORT_PAGE_SIZE = 20000;
    let allClients = [];
    try {
      let page = 1;
      while (true) {
        btn.textContent = `Se pregătește… (${allClients.length} preluați)`;
        const { items, total } = await api(`/api/platform-admin/clients?page=${page}&pageSize=${EXPORT_PAGE_SIZE}`);
        allClients = allClients.concat(items);
        if (allClients.length >= total || items.length < EXPORT_PAGE_SIZE) break;
        page += 1;
      }
      if (!allClients.length) { showToast('Niciun client de exportat.'); return; }
      const ws = XLSX.utils.json_to_sheet(allClients.map((c) => ({
        Nume: c.name || '', Adresă: c.address || '', Oraș: c.city || '', Județ: c.county || '', Telefon: c.phone || '', Email: c.email || '',
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Clienți');
      XLSX.writeFile(wb, `clienti-platforma-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      showToast('Eroare: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '↓ Descarcă toți';
    }
  });
}

function renderForgotPassword(statusMsg, isError) {
  app.innerHTML = '';
  const card = el(`
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="mark">S</div>
          <div class="name">Panou Suport</div>
        </div>
        <h1>Am uitat parola</h1>
        <p class="sub">Introdu emailul contului tău — dacă există, primești un link de resetare.</p>
        ${statusMsg ? `<div class="${isError ? 'error-msg' : 'hint'}" style="${isError ? '' : 'background:rgba(107,196,130,0.1);border:1px solid rgba(107,196,130,0.3);border-radius:8px;padding:10px 12px;margin-bottom:14px;'}">${escapeHtml(statusMsg)}</div>` : ''}
        <form id="forgot-form">
          <div class="field">
            <label for="fpEmail">Email</label>
            <input type="email" id="fpEmail" placeholder="tu@firma.ro" required autofocus />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Trimite link de resetare</button>
        </form>
        <div class="hint" style="text-align:center;margin-top:16px;">
          <a href="#" id="goLoginBack" style="color:var(--accent);">← Înapoi la autentificare</a>
        </div>
      </div>
    </div>
  `);
  app.appendChild(card);

  card.querySelector('#goLoginBack').addEventListener('click', (e) => {
    e.preventDefault();
    navigate('#/login');
  });

  card.querySelector('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = card.querySelector('#fpEmail').value.trim();
    const btn = card.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const result = await api('/api/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      renderForgotPassword(result.message, false);
    } catch (err) {
      renderForgotPassword(err.message, true);
    }
  });
}

function renderResetPassword(token) {
  app.innerHTML = '';
  const card = el(`
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="mark">S</div>
          <div class="name">Panou Suport</div>
        </div>
        <h1>Parolă nouă</h1>
        <p class="sub">Alege o parolă nouă pentru contul tău.</p>
        <div id="reset-error"></div>
        <form id="reset-form">
          <div class="field">
            <label for="newPw">Parolă nouă</label>
            <input type="password" id="newPw" placeholder="minimum 8 caractere" required minlength="8" />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Salvează parola nouă</button>
        </form>
      </div>
    </div>
  `);
  app.appendChild(card);

  card.querySelector('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = card.querySelector('#newPw').value;
    const btn = card.querySelector('button[type="submit"]');
    const errorBox = card.querySelector('#reset-error');
    btn.disabled = true;
    try {
      await api('/api/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
      showToast('Parolă schimbată cu succes — te poți autentifica acum.');
      navigate('#/login');
      render();
    } catch (err) {
      errorBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

function renderLogin(errorMsg) {
  app.innerHTML = '';
  const card = el(`
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="mark">S</div>
          <div class="name">Panou Suport</div>
        </div>
        <h1>Autentificare</h1>
        <p class="sub">Introdu emailul și parola contului tău.</p>
        ${errorMsg ? `<div class="error-msg">${escapeHtml(errorMsg)}</div>` : ''}
        <form id="login-form">
          <div class="field">
            <label for="loginEmail">Email</label>
            <input type="email" id="loginEmail" placeholder="tu@firma.ro" required autofocus />
          </div>
          <div class="field">
            <label for="pw">Parolă</label>
            <input type="password" id="pw" placeholder="••••••••" required />
            <div style="text-align:right;margin-top:6px;"><a href="#" id="goForgotPassword" style="color:var(--text-secondary);font-size:12.5px;">Am uitat parola</a></div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Autentificare</button>
        </form>
        <div class="hint" style="text-align:center;margin-top:16px;">
          Nu ai cont? <a href="#" id="goSignup" style="color:var(--accent);">Creează unul pentru compania ta</a>
        </div>
      </div>
    </div>
  `);
  app.appendChild(card);

  card.querySelector('#goForgotPassword').addEventListener('click', (e) => {
    e.preventDefault();
    navigate('#/forgot-password');
  });

  card.querySelector('#goSignup').addEventListener('click', (e) => {
    e.preventDefault();
    navigate('#/signup');
  });

  card.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = card.querySelector('#loginEmail').value.trim();
    const password = card.querySelector('#pw').value;
    try {
      currentAgent = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      await loadReferenceData();
      navigate('#/dashboard');
      render();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function renderSignup(errorMsg) {
  app.innerHTML = '';
  const card = el(`
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="mark">S</div>
          <div class="name">Panou Suport</div>
        </div>
        <h1>Creează cont nou</h1>
        <p class="sub">Pornește contul companiei tale — devii automat manager.</p>
        ${errorMsg ? `<div class="error-msg">${escapeHtml(errorMsg)}</div>` : ''}
        <form id="signup-form">
          <div class="field">
            <label for="suCompany">Numele companiei</label>
            <input type="text" id="suCompany" placeholder="Firma Ta SRL" required autofocus />
          </div>
          <div class="field">
            <label for="suName">Numele tău</label>
            <input type="text" id="suName" placeholder="Ion Popescu" required />
          </div>
          <div class="field">
            <label for="suEmail">Email</label>
            <input type="email" id="suEmail" placeholder="tu@firma.ro" required />
          </div>
          <div class="field">
            <label for="suPassword">Parolă</label>
            <input type="password" id="suPassword" placeholder="minimum 8 caractere" required minlength="8" />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Creează cont</button>
        </form>
        <div class="hint" style="text-align:center;margin-top:16px;">
          Ai deja cont? <a href="#" id="goLogin" style="color:var(--accent);">Autentifică-te</a>
        </div>
      </div>
    </div>
  `);
  app.appendChild(card);

  card.querySelector('#goLogin').addEventListener('click', (e) => {
    e.preventDefault();
    navigate('#/login');
  });

  card.querySelector('#signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      companyName: card.querySelector('#suCompany').value.trim(),
      agentName: card.querySelector('#suName').value.trim(),
      email: card.querySelector('#suEmail').value.trim(),
      password: card.querySelector('#suPassword').value,
    };
    const submitBtn = card.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Se creează…';
    try {
      const result = await api('/api/signup', { method: 'POST', body: JSON.stringify(payload) });
      currentAgent = result.agent;
      await loadReferenceData();
      navigate('#/dashboard');
      render();
    } catch (err) {
      renderSignup(err.message);
    }
  });
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  if (isPlatformAdmin) {
    try { await api('/api/platform-admin/logout', { method: 'POST' }); } catch (e) { /* ignoram */ }
  }
  currentAgent = null;
  isPlatformAdmin = false;
  window.location.hash = '#/login';
  render();
}

// ---------------- shell (sidebar + main) ----------------

// etape in care coletul a ajuns deja fizic la service (nu mai are sens sa anulezi AWB-ul de ridicare)
const ARRIVED_STAGES = ['at_service', 'return_awb_issued', 'in_transit_to_client', 'delivered_to_client'];

const NAV_ICONS = {
  dashboard: '<svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="6" height="6" rx="1.2"/><rect x="8.5" y="1.5" width="6" height="4" rx="1.2"/><rect x="8.5" y="7.5" width="6" height="7" rx="1.2"/><rect x="1.5" y="9.5" width="6" height="5" rx="1.2"/></svg>',
  tickets: '<svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 5.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1.2a1.3 1.3 0 0 0 0 2.6v1.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V9.3a1.3 1.3 0 0 0 0-2.6V5.5Z"/><path d="M6 4.5v7" stroke-dasharray="1.6 1.6"/></svg>',
  orders: '<svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4.8 8 2l6 2.8v6.4L8 14 2 11.2V4.8Z"/><path d="M2 4.8 8 7.6l6-2.8M8 7.6V14"/></svg>',
  service: '<svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.8 3.2a3 3 0 0 0-4 3.6L2 10.6l1.4 1.4 3.8-3.8a3 3 0 0 0 3.6-4L9 6l-1-1 1.8-1.8Z"/></svg>',
  retur: '<svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M1.5 2.5v2.6h2.6"/></svg>',
  schimb: '<svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5h9.5M11.5 5 9 2.5M11.5 5 9 7.5"/><path d="M14 11H4.5M4.5 11 7 8.5M4.5 11 7 13.5"/></svg>',
  admin: '<svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5 13 3.5v3.8c0 3.4-2.2 5.7-5 6.7-2.8-1-5-3.3-5-6.7V3.5L8 1.5Z"/><path d="M5.8 8 7.3 9.5l3-3.2"/></svg>',
};

function renderShell(activeRoute, contentNode) {
  app.innerHTML = '';
  currentMainRoute = activeRoute;

  // Construim sidebar si zona principala ca doua elemente separate (nu un
  // singur bloc cu doi radacini surori) -- el() intoarce doar primul element
  // dintr-un template HTML, deci doua radacini surori ar pierde-o pe a doua.
  const sidebar = el(`
    <div class="sidebar" id="sidebar">
      <div class="brand">
        <div class="eyebrow">Suport clienți</div>
        <div class="name">Panou Suport</div>
      </div>
      <nav class="nav">
        <div class="nav-item" data-route="#/dashboard">${NAV_ICONS.dashboard}Panou Control</div>
        <div class="nav-item" data-route="#/orders">${NAV_ICONS.orders}Comenzi</div>
        <div class="nav-item" data-route="#/tickets">${NAV_ICONS.tickets}Tichete</div>
        <div class="nav-item" data-route="#/service">${NAV_ICONS.service}Service</div>
        <div class="nav-item" data-route="#/retur">${NAV_ICONS.retur}Retur</div>
        <div class="nav-item" data-route="#/schimb">${NAV_ICONS.schimb}Colet la Schimb</div>
        ${isPlatformAdmin ? `<div class="nav-item" data-route="#/administrare-platforma" style="color:var(--accent);">🛠️ Administrare Platformă</div>` : ''}
        ${isPlatformAdmin ? `<div class="nav-item" data-route="#/administrare-platforma-clienti" style="color:var(--accent);">👤 Clienți (toate companiile)</div>` : ''}
      </nav>
      <div class="sidebar-spacer"></div>
      <nav class="nav" style="border-top:1px solid var(--border);padding-top:8px;margin-bottom:4px;">
        ${currentAgent.role === 'manager' ? `<div class="nav-item" data-route="#/admin">${NAV_ICONS.admin}Administrare</div>` : ''}
        ${currentAgent.role === 'manager' ? `<div class="nav-item" data-route="#/settings">⚙️ Setări</div>` : ''}
      </nav>
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
          <h1>Panou Control</h1>
          <div class="sub">Vedere de ansamblu — Tichete, Comenzi, Service, Retur, Colet la Schimb</div>
        </div>
      </div>
      <div id="dash-body">Se încarcă…</div>
    </div>
  `);
  renderShell('#/dashboard', content);

  const todayRange = computePeriodRange('today');
  const [stats, orderStats, serviceTickets, returTickets, schimbTickets, allTickets] = await Promise.all([
    api('/api/stats'),
    api(`/api/orders/stats?dateFrom=${encodeURIComponent(todayRange.dateFrom)}&dateTo=${encodeURIComponent(todayRange.dateTo)}`).catch(() => null),
    api('/api/tickets?section=service').catch(() => []),
    api('/api/tickets?section=retur').catch(() => []),
    api('/api/tickets?section=schimb').catch(() => []),
    api('/api/tickets?sort=priority'),
  ]);

  const body = content.querySelector('#dash-body');

  const isActive = (t) => t.status !== 'resolved' && t.status !== 'closed';
  const serviceActive = serviceTickets.filter(isActive);
  const returActive = returTickets.filter(isActive);
  const schimbActive = schimbTickets.filter(isActive);
  const overdueAll = [...serviceTickets, ...returTickets, ...schimbTickets].filter((t) => isPastDeadline(t));

  const unassignedOpen = allTickets.filter((t) => !t.assignedTo && ['open', 'in_progress', 'waiting'].includes(t.status));

  // ---- feed unificat "Necesita atentie azi" ----
  const attentionRows = [
    ...overdueAll.map((t) => `
      <div class="queue-item" data-id="${t.id}">
        <span class="badge badge-priority-urgent">Peste 7 zile</span>
        <span class="qid">${escapeHtml(t.sectionCode || t.id)}</span>
        <span class="qsubject">${escapeHtml(t.subject)} — ${escapeHtml(t.requesterName)}</span>
        <span class="badge" style="background:rgba(255,255,255,0.06);">${stageStatusLabel(t.stage, t.section)}</span>
      </div>
    `),
    ...unassignedOpen.slice(0, 5).map((t) => `
      <div class="queue-item" data-id="${t.id}">
        <span class="badge badge-status-closed">Neasignat</span>
        <span class="qid">${escapeHtml(t.sectionCode || t.id)}</span>
        <span class="qsubject">${escapeHtml(t.subject)}</span>
        <span class="badge badge-status-${t.status}">${STATUS_LABELS[t.status]}</span>
      </div>
    `),
  ].join('');
  const attentionHtml = attentionRows || '<div class="empty">Nimic urgent — totul e sub control.</div>';

  body.innerHTML = `
    <div class="stat-grid" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));">
      <div class="stat-tile accented"><span class="corner-dot glow-dot" style="background:var(--accent);"></span><div class="label">Comenzi azi</div><div class="value">${orderStats ? orderStats.total : '—'}</div></div>
      <div class="stat-tile"><span class="corner-dot" style="background:var(--status-open);"></span><div class="label">Tichete deschise</div><div class="value">${stats.byStatus.open}</div></div>
      <div class="stat-tile"><span class="corner-dot" style="background:var(--status-waiting);"></span><div class="label">Service activ</div><div class="value">${serviceActive.length}</div></div>
      <div class="stat-tile"><span class="corner-dot" style="background:var(--status-in_progress);"></span><div class="label">Retur activ</div><div class="value">${returActive.length}</div></div>
      <div class="stat-tile"><span class="corner-dot" style="background:var(--status-waiting);"></span><div class="label">Colet la Schimb</div><div class="value">${schimbActive.length}</div></div>
      <div class="stat-tile"><span class="corner-dot glow-dot" style="background:var(--priority-urgent);"></span><div class="label">Peste 7 zile</div><div class="value" style="color:${overdueAll.length ? 'var(--priority-urgent)' : 'var(--text)'};">${overdueAll.length}</div></div>
    </div>

    <div class="panel" style="margin-bottom:16px;">
      <h2>Necesită atenție azi</h2>
      <div>${attentionHtml}</div>
    </div>

    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
        <h2 style="margin:0;">Analiză Service / Retur / Colet la Schimb</h2>
        <div id="analyticsPeriodPicker"></div>
      </div>
      <div id="analyticsBody">Se încarcă…</div>
    </div>
  `;

  body.querySelectorAll('.queue-item').forEach((item) => {
    item.addEventListener('click', () => openTicketDrawerCrossLink(item.dataset.id));
  });

  await renderProductAnalytics(body.querySelector('#analyticsPeriodPicker'), body.querySelector('#analyticsBody'));
}

async function renderProductAnalytics(pickerContainer, analyticsBody) {
  let filters = { dateFrom: '', dateTo: '' }; // implicit: "Toate" (fara filtrare de data)

  async function loadAnalytics() {
    analyticsBody.innerHTML = 'Se încarcă…';
    try {
      const params = new URLSearchParams();
      if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) params.set('dateTo', filters.dateTo);
      const data = await api(`/api/product-analytics?${params.toString()}`);

      const topList = (items, emptyMsg) => {
        if (!items.length) return `<div class="empty">${emptyMsg}</div>`;
        const max = Math.max(1, ...items.map((p) => p.count));
        return items.map((p) => `
          <div class="bar-row">
            <div class="bar-label">${escapeHtml(p.name)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(p.count / max) * 100}%"></div></div>
            <div class="bar-count">${p.count}</div>
          </div>
        `).join('');
      };

      analyticsBody.innerHTML = `
        <div class="stat-grid" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));margin-bottom:20px;">
          <div class="stat-tile"><span class="corner-dot" style="background:var(--status-in_progress);"></span><div class="label">Retururi</div><div class="value">${data.counts.retur}</div></div>
          <div class="stat-tile"><span class="corner-dot" style="background:var(--status-waiting);"></span><div class="label">Colete la Schimb</div><div class="value">${data.counts.schimb}</div></div>
          <div class="stat-tile"><span class="corner-dot" style="background:var(--status-open);"></span><div class="label">Colete în Service</div><div class="value">${data.counts.service}</div></div>
        </div>
        <div class="dash-grid">
          <div class="panel">
            <h2>Produse cel mai des returnate</h2>
            ${topList(data.topReturProducts, 'Niciun retur în această perioadă.')}
          </div>
          <div>
            <div class="panel" style="margin-bottom:16px;">
              <h2>Produse cel mai des la Schimb</h2>
              ${topList(data.topSchimbProducts, 'Niciun colet la schimb în această perioadă.')}
            </div>
            <div class="panel">
              <h2>Produse care revin cel mai des în Service</h2>
              ${topList(data.topServiceProducts, 'Niciun tichet de service în această perioadă.')}
            </div>
          </div>
        </div>
      `;
    } catch (e) {
      analyticsBody.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }

  renderPeriodPicker(pickerContainer, filters, (range) => {
    filters = range;
    loadAnalytics();
  });
  await loadAnalytics();
}

// ---------------- Listă tichete ----------------

function parseListRoute(hash) {
  const [, qs] = hash.split('?');
  return Object.fromEntries(new URLSearchParams(qs || ''));
}

// ---------------- Selector de perioadă (reutilizabil: tichete + comenzi) ----------------

function computePeriodRange(period, customFrom, customTo) {
  const now = new Date();
  let from = null, to = null;
  if (period === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === 'yesterday') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
  } else if (period === 'week') {
    const day = now.getDay();
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0, 0);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999);
    from = monday; to = sunday;
  } else if (period === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === 'custom') {
    from = customFrom ? new Date(customFrom + 'T00:00:00') : null;
    to = customTo ? new Date(customTo + 'T23:59:59') : null;
  }
  return { dateFrom: from ? from.toISOString() : '', dateTo: to ? to.toISOString() : '' };
}

function detectActivePeriod(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return 'all';
  for (const p of ['today', 'yesterday', 'week', 'month']) {
    const r = computePeriodRange(p);
    if (r.dateFrom === dateFrom && r.dateTo === dateTo) return p;
  }
  return 'custom';
}

/** Randează selectorul de perioadă într-un container și apelează applyFn({dateFrom, dateTo}) la selecție. */
function renderPeriodPicker(container, filters, applyFn) {
  const active = detectActivePeriod(filters.dateFrom, filters.dateTo);
  const options = [
    { key: 'all', label: '↺ Toate' },
    { key: 'today', label: 'Azi' },
    { key: 'yesterday', label: 'Ieri' },
    { key: 'week', label: 'Săptămâna aceasta' },
    { key: 'month', label: 'Luna aceasta' },
    { key: 'custom', label: 'Personalizat' },
  ];
  container.innerHTML = `
    <div class="status-pills segmented-group" id="periodPillsRow" style="margin-bottom:0;">
      ${options.map((o) => `<button class="status-pill ${active === o.key ? 'active' : ''}" data-period="${o.key}">${o.label}</button>`).join('')}
    </div>
    <div class="period-custom-inputs" id="periodCustomInputs" style="${active === 'custom' ? 'display:flex;' : 'display:none;'}margin-top:10px;">
      <input type="date" id="periodFromInput" value="${filters.dateFrom ? filters.dateFrom.slice(0, 10) : ''}" />
      <span class="period-arrow">→</span>
      <input type="date" id="periodToInput" value="${filters.dateTo ? filters.dateTo.slice(0, 10) : ''}" />
      <button class="btn btn-sm btn-primary" id="periodApplyBtn">Aplică</button>
    </div>
  `;

  container.querySelectorAll('.status-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      const period = pill.dataset.period;
      if (period === 'custom') {
        container.querySelectorAll('.status-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        container.querySelector('#periodCustomInputs').style.display = 'flex';
        return; // asteptam butonul Aplica
      }
      if (period === 'all') {
        applyFn({ dateFrom: '', dateTo: '', period: 'all' });
        return;
      }
      applyFn({ ...computePeriodRange(period), period: '' });
    });
  });

  const applyBtn = container.querySelector('#periodApplyBtn');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const from = container.querySelector('#periodFromInput').value;
      const to = container.querySelector('#periodToInput').value;
      applyFn(computePeriodRange('custom', from, to));
    });
  }
}

const SECTION_CONFIG = {
  '#/tickets': { section: 'support', title: 'Tichete', sub: 'Toate solicitările clienților' },
  '#/service': { section: 'service', title: 'Service', sub: 'Tichete cu ridicare pentru reparație/service' },
  '#/retur': { section: 'retur', title: 'Retur', sub: 'Tichete cu ridicare pentru returnare produs' },
  '#/schimb': { section: 'schimb', title: 'Colet la Schimb', sub: 'Tichete cu AWB de colet la schimb' },
};

/** Randeaza fundalul corect pentru o ruta de lista de tichete (generica sau Service/Retur). */
async function renderBackgroundForRoute(route) {
  if (route === '#/service') return renderServiceReturnList('#/service', 'service');
  if (route === '#/retur') return renderServiceReturnList('#/retur', 'retur');
  if (route === '#/schimb') return renderServiceReturnList('#/schimb', 'schimb');
  return renderTicketsList(route);
}

/** Lista specializata pentru Service/Retur/Schimb — coloane si tab-uri dedicate. */
async function renderServiceReturnList(route, section) {
  const isRetur = section === 'retur';
  const title = SECTION_CONFIG[route]?.title || 'Service';
  const subtitle = {
    service: 'Reparații în garanție: ridicare de la client → atelier → livrare înapoi.',
    retur: 'Retur produse: ridicare de la client → depozit → procesare rambursare.',
    schimb: 'Colet la schimb: ridicare produs vechi + livrare produs nou, într-o singură vizită a curierului.',
  }[section];
  const titleIconColor = { service: 'var(--status-open)', retur: 'var(--status-in_progress)', schimb: 'var(--status-waiting)' }[section];
  const initialFilters = parseListRoute(window.location.hash);

  const content = el(`
    <div>
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="color:${titleIconColor};">${NAV_ICONS[section]}</span>
          <div>
            <h1>${title}</h1>
            <div class="sub">${subtitle}</div>
          </div>
        </div>
      </div>
      <div class="status-pills segmented-group" id="tabRow" style="margin-bottom:18px;"></div>
      <div class="filters-search-row">
        <input type="text" id="q" placeholder="Caută: cod, comandă, client, produs, AWB…" value="${escapeHtml(initialFilters.q || '')}" />
      </div>
      ${section === 'service' || section === 'retur' ? `
        <div class="segmented-group" id="locationRow" style="margin-bottom:18px;"></div>
      ` : ''}
      ${section === 'retur' ? `
        <div id="bulkRefundExportArea" style="display:none;margin-bottom:14px;gap:8px;align-items:center;">
          <button class="btn btn-sm" id="selectAllRefundBtn">Selectează toate</button>
          <button class="btn btn-sm btn-primary" id="bulkRefundExportBtn">↓ Descarcă date bancare (<span id="bulkRefundCount">0</span> selectate)</button>
        </div>
      ` : ''}
      <div id="list-body">Se încarcă…</div>
    </div>
  `);
  renderShell(route, content);

  // ---- incarcare UNICA de date: tichete + comenzile lor asociate. Comutarea
  // intre tab-uri/sectiuni de mai jos filtreaza doar local, in memorie, fara
  // niciun apel nou catre server -- altfel fiecare click ar reface un fetch
  // complet, cu intarzierea vizibila resimtita inainte.
  let allTickets;
  try {
    allTickets = await api(`/api/tickets?section=${section}`);
  } catch (e) {
    content.querySelector('#list-body').innerHTML = `<div class="panel">Eroare: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const linkedOrders = {};
  await Promise.all(allTickets.filter((t) => t.relatedOrderId).map(async (t) => {
    try { linkedOrders[t.id] = await api(`/api/orders/${t.relatedOrderId}`); } catch (e) { /* comanda poate lipsi */ }
  }));

  if (platformLabel === 'MERCHANTPRO') {
    try { const s = await api('/api/orders/sync-status'); platformLabel = s.platformLabel || platformLabel; } catch (e) { /* n-o blocam */ }
  }

  // stare locala (nu mai citim din URL la fiecare click -- doar la incarcarea initiala)
  const LOCATION_KEYS_BY_SECTION = {
    service: ['picked', 'inservice', 'returned'],
    retur: ['picked', 'waitingIban', 'readyRefund'],
  };
  let activeLocation = LOCATION_KEYS_BY_SECTION[section]?.includes(initialFilters.loc) ? initialFilters.loc : 'picked';
  let activeTab = initialFilters.tab || 'all';
  let searchQuery = initialFilters.q || '';
  const selectedRefundTicketIds = new Set(); // pentru selectia manuala de export in "Gata de Retur"
  function updateBulkRefundExportLabel() {
    const countSpan = content.querySelector('#bulkRefundCount');
    if (countSpan) countSpan.textContent = selectedRefundTicketIds.size;
  }

  function updateUrlSilently() {
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (activeTab) params.set('tab', activeTab);
    if (section === 'service') params.set('loc', activeLocation);
    history.replaceState(null, '', `${route}?${params.toString()}`);
  }

  function renderAll() {
    let tickets = allTickets;

    // pentru Service: trei sectiuni de nivel superior, dupa unde se afla fizic
    // coletul -- mutarea e automata, pe baza statusului real de la curier
    if (section === 'service') {
      const locationBuckets = {
        picked: allTickets.filter((t) => t.pickupAwbNumber && ['pickup_awb_issued', 'in_transit_to_service'].includes(t.stage)),
        inservice: allTickets.filter((t) => ['at_service', 'return_awb_issued', 'in_transit_to_client'].includes(t.stage)),
        returned: allTickets.filter((t) => t.stage === 'delivered_to_client'),
      };
      const locationTabs = [
        { key: 'picked', label: 'Colete Ridicate' },
        { key: 'inservice', label: 'In Service' },
        { key: 'returned', label: 'Inapoi la Client' },
      ];
      content.querySelector('#locationRow').innerHTML = locationTabs.map((t) =>
        `<button class="status-pill ${activeLocation === t.key ? 'active' : ''}" data-loc="${t.key}">${t.label}<span class="status-pill-count">${locationBuckets[t.key].length}</span></button>`
      ).join('');
      content.querySelectorAll('#locationRow .status-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeLocation = btn.dataset.loc;
          updateUrlSilently();
          renderAll();
        });
      });
      tickets = locationBuckets[activeLocation];
    }

    // pentru Retur: la fel, dar a treia sectiune depinde si de IBAN completat,
    // nu doar de starea curierului -- mutarea in "Gata de Retur" se intampla
    // automat doar dupa salvarea datelor bancare (vezi butonul din tichet)
    if (section === 'retur') {
      const locationBuckets = {
        picked: allTickets.filter((t) => t.pickupAwbNumber && ['pickup_awb_issued', 'in_transit_to_service'].includes(t.stage)),
        waitingIban: allTickets.filter((t) => t.stage === 'at_service' && !t.refundIban),
        readyRefund: allTickets.filter((t) => t.stage === 'at_service' && t.refundIban),
      };
      const locationTabs = [
        { key: 'picked', label: 'Colete Ridicate' },
        { key: 'waitingIban', label: 'In așteptare IBAN' },
        { key: 'readyRefund', label: 'Gata de Retur' },
      ];
      content.querySelector('#locationRow').innerHTML = locationTabs.map((t) =>
        `<button class="status-pill ${activeLocation === t.key ? 'active' : ''}" data-loc="${t.key}">${t.label}<span class="status-pill-count">${locationBuckets[t.key].length}</span></button>`
      ).join('');
      content.querySelectorAll('#locationRow .status-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeLocation = btn.dataset.loc;
          updateUrlSilently();
          renderAll();
        });
      });
      tickets = locationBuckets[activeLocation];

      // export in bloc, doar cand suntem in "Gata de Retur" si sunt 2+ tichete acolo
      const bulkExportArea = content.querySelector('#bulkRefundExportArea');
      if (bulkExportArea) {
        if (activeLocation === 'readyRefund' && locationBuckets.readyRefund.length > 1) {
          bulkExportArea.style.display = 'flex';
          // curatam din selectie orice id care nu mai e in lista curenta (ex: iban sters between timp)
          const readyIds = new Set(locationBuckets.readyRefund.map((t) => t.id));
          for (const id of Array.from(selectedRefundTicketIds)) {
            if (!readyIds.has(id)) selectedRefundTicketIds.delete(id);
          }
          updateBulkRefundExportLabel();
        } else {
          bulkExportArea.style.display = 'none';
        }
      }

    }

    const buckets = {
      open: tickets.filter((t) => t.status !== 'resolved' && t.status !== 'closed'),
      atelier: tickets.filter((t) => t.stage === 'at_service'),
      overdue: tickets.filter((t) => isPastDeadline(t)),
      closed: tickets.filter((t) => t.status === 'resolved' || t.status === 'closed'),
      all: tickets,
    };

    const tabs = [
      { key: 'open', label: 'Deschise' },
      { key: 'atelier', label: { service: 'La atelier', retur: 'La depozit', schimb: 'Finalizate' }[section] },
      { key: 'overdue', label: 'Peste 7 zile' },
      { key: 'closed', label: 'Închise' },
      { key: 'all', label: 'Toate' },
    ];
    content.querySelector('#tabRow').innerHTML = tabs.map((t) =>
      `<button class="status-pill ${activeTab === t.key ? 'active' : ''}" data-tab="${t.key}">${t.label}<span class="status-pill-count">${buckets[t.key].length}</span></button>`
    ).join('');
    content.querySelectorAll('#tabRow .status-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        updateUrlSilently();
        renderAll();
      });
    });

    const q = searchQuery.toLowerCase();
    let rows = buckets[activeTab] || buckets.open;
    if (q) {
      rows = rows.filter((t) => {
        const order = linkedOrders[t.id];
        const haystack = [t.sectionCode, t.requesterName, t.pickupAwbNumber, t.returnAwbNumber, order?.mpId, order?.lineItems?.[0]?.product_name, t.subject]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    const listBody = content.querySelector('#list-body');
    if (!rows.length) {
      listBody.innerHTML = `<div class="panel" style="text-align:center;color:var(--text-dim);">Niciun tichet în această categorie.</div>`;
    } else {
      const showRefundSelect = section === 'retur' && activeLocation === 'readyRefund';
      const isSchimb = section === 'schimb';
      const tableRows = rows.map((t) => {
        const order = linkedOrders[t.id];
        const product = order?.lineItems?.[0]
          ? `${escapeHtml(order.lineItems[0].product_name || '—')}`
          : escapeHtml(t.subject);
        const deadline = computeDeadline(t);
        const overdue = isPastDeadline(t);
        const statusColumns = isSchimb ? `
          <div><span class="status-pill" style="cursor:default;padding:5px 11px;"><span class="status-pill-dot" style="background:${stageDotColor(t.stage)};"></span>${stageStatusLabel(t.stage, t.section)}</span></div>
          <div><span class="status-pill" style="cursor:default;padding:5px 11px;"><span class="status-pill-dot" style="background:${stageSecondaryDotColor(t.pickupAwbSecondaryStage)};"></span>${stageSecondaryStatusLabel(t.pickupAwbSecondaryStage, Boolean(t.pickupAwbSecondaryNumber))}</span></div>
        ` : `
          <div><span class="status-pill ${['at_service', 'delivered_to_client'].includes(t.stage) && t.stage === 'delivered_to_client' ? 'status-pill-filled-green' : ''}" style="cursor:default;padding:5px 11px;"><span class="status-pill-dot" style="background:${stageDotColor(t.stage)};"></span>${stageStatusLabel(t.stage, t.section)}</span></div>
          <div style="color:var(--text-secondary);font-size:12.5px;">${stageLocationLabel(t.stage, t.section)}</div>
        `;
        return `
        <div class="service-row" data-id="${t.id}">
          <div class="service-cod">${showRefundSelect ? `<input type="checkbox" class="refund-select-cb" data-id="${t.id}" ${selectedRefundTicketIds.has(t.id) ? 'checked' : ''} style="margin-right:8px;vertical-align:middle;" />` : ''}${escapeHtml(t.sectionCode || t.id)}</div>
          <div class="order-platform"><span class="platform-dot"></span>${escapeHtml(platformLabel)}</div>
          ${statusColumns}
          <div class="order-id">${order ? `#${order.mpId}` : '—'}</div>
          <div class="t-title" style="font-size:13px;">${escapeHtml(t.requesterName)}${t.refundPaidAt ? ' <span style="color:var(--status-resolved);" title="Bani Returnați">✓</span>' : ''}</div>
          <div class="t-requester" style="font-size:12.5px;color:var(--text-secondary);">${product}</div>
          <div style="font-size:12px;color:${overdue ? 'var(--priority-urgent)' : 'var(--text-dim)'};white-space:nowrap;">${deadline ? `⏱ ${fmtShortDate(deadline)}` : '—'}</div>
        </div>`;
      }).join('');

      listBody.innerHTML = `
        <div class="ticket-table">
          <div class="service-row header">
            ${isSchimb
              ? '<div>COD</div><div>CANAL</div><div>STATUS TUR</div><div>STATUS RETUR</div><div>COMANDĂ</div><div>CLIENT</div><div>PRODUS</div><div>TERMEN 7 ZILE</div>'
              : '<div>COD</div><div>CANAL</div><div>STATUS</div><div>UNDE E MARFA</div><div>COMANDĂ</div><div>CLIENT</div><div>PRODUS</div><div>TERMEN 7 ZILE</div>'}
          </div>
          ${tableRows}
        </div>
      `;
      listBody.querySelectorAll('.service-row[data-id]').forEach((row) => {
        row.addEventListener('click', () => {
          history.pushState(null, '', `#/tickets/${row.dataset.id}`);
          openTicketDrawer(row.dataset.id);
        });
      });

      if (showRefundSelect) {
        listBody.querySelectorAll('.refund-select-cb').forEach((cb) => {
          cb.addEventListener('click', (e) => e.stopPropagation()); // nu deschide tichetul la bifare
          cb.addEventListener('change', () => {
            if (cb.checked) selectedRefundTicketIds.add(cb.dataset.id);
            else selectedRefundTicketIds.delete(cb.dataset.id);
            updateBulkRefundExportLabel();
          });
        });
      }
    }
  }

  renderAll();

  const bulkRefundExportBtn = content.querySelector('#bulkRefundExportBtn');
  if (bulkRefundExportBtn) {
    bulkRefundExportBtn.addEventListener('click', async () => {
      if (!selectedRefundTicketIds.size) { showToast('Selectează cel puțin un tichet.'); return; }
      const selectedTickets = allTickets.filter((t) => selectedRefundTicketIds.has(t.id));
      const ws = XLSX.utils.json_to_sheet(selectedTickets.map((t) => ({
        Tichet: t.sectionCode || t.id,
        Client: t.requesterName || '',
        IBAN: t.refundIban || '',
        'Titular cont': t.refundAccountHolder || '',
        'Sumă (RON)': t.refundAmount != null ? t.refundAmount : '',
        Motiv: t.refundReason || '',
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Date bancare');
      XLSX.writeFile(wb, `date-bancare-retur-${new Date().toISOString().slice(0, 10)}.xlsx`);

      try {
        const idsToMark = Array.from(selectedRefundTicketIds);
        await api('/api/tickets/mark-refund-paid-bulk', { method: 'POST', body: JSON.stringify({ ticketIds: idsToMark }) });
        const markedSet = new Set(idsToMark);
        allTickets.forEach((t) => { if (markedSet.has(t.id)) t.refundPaidAt = new Date().toISOString(); });
        showToast(`${idsToMark.length} tichete marcate „Bani Returnați"`);
        selectedRefundTicketIds.clear();
        renderAll();
      } catch (e) {
        showToast('Export reușit, dar marcarea a eșuat: ' + e.message);
      }
    });
  }

  const selectAllRefundBtn = content.querySelector('#selectAllRefundBtn');
  if (selectAllRefundBtn) {
    selectAllRefundBtn.addEventListener('click', () => {
      const readyTickets = allTickets.filter((t) => t.stage === 'at_service' && t.refundIban);
      const allSelected = readyTickets.every((t) => selectedRefundTicketIds.has(t.id));
      if (allSelected) {
        selectedRefundTicketIds.clear(); // toate erau deja bifate -- debifam tot
      } else {
        readyTickets.forEach((t) => selectedRefundTicketIds.add(t.id));
      }
      renderAll();
    });
  }

  let qTimer;
  content.querySelector('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      searchQuery = content.querySelector('#q').value.trim();
      updateUrlSilently();
      renderAll();
    }, 350);
  });
}

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
        <input type="text" id="q" placeholder="Caută subiect, client, ID, telefon, AWB…" value="${escapeHtml(filters.q || '')}" />
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
      <div class="status-pills-label">Perioadă</div>
      <div id="periodPickerContainer"></div>
      <div id="list-body">Se încarcă…</div>
    </div>
  `);
  renderShell(route, content);

  content.querySelector('#newTicketBtn').addEventListener('click', () => openNewTicketDrawer(null));

  function applyFiltersFromForm(overrides = {}) {
    const params = new URLSearchParams();
    const q = content.querySelector('#q').value.trim();
    const status = content.querySelector('#f-status').value;
    const priority = content.querySelector('#f-priority').value;
    const category = content.querySelector('#f-category').value;
    const assignedTo = content.querySelector('#f-assigned').value;
    const merged = { dateFrom: filters.dateFrom || '', dateTo: filters.dateTo || '', ...overrides };
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (category) params.set('category', category);
    if (assignedTo) params.set('assignedTo', assignedTo);
    if (merged.dateFrom) params.set('dateFrom', merged.dateFrom);
    if (merged.dateTo) params.set('dateTo', merged.dateTo);
    navigate(`${route}?${params.toString()}`);
  }

  renderPeriodPicker(content.querySelector('#periodPickerContainer'), filters, applyFiltersFromForm);

  ['#f-status', '#f-priority', '#f-category', '#f-assigned'].forEach((sel) => {
    content.querySelector(sel).addEventListener('change', () => applyFiltersFromForm());
  });
  let qTimer;
  content.querySelector('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => applyFiltersFromForm(), 350);
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
  const bgRoute = { service: '#/service', retur: '#/retur', schimb: '#/schimb' }[ticket.section] || '#/tickets';
  if (currentMainRoute !== bgRoute) await renderBackgroundForRoute(bgRoute);
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

  let ticketPhotos = [];
  try { ticketPhotos = await api(`/api/tickets/${ticket.id}/photos`); } catch (e) { /* n-o blocam afisarea */ }

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
          <div class="ticket-header-card" style="position:relative;">
            ${ticket.section === 'service' ? `
              <div style="position:absolute;top:16px;right:16px;">
                <button class="btn btn-sm" id="manualMoveBtn">↕ Mută tichetul manual</button>
                <div id="manualMoveMenu" style="display:none;position:absolute;top:calc(100% + 6px);right:0;background:var(--surface-raised);border:1px solid var(--border);border-radius:8px;padding:6px;min-width:180px;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,0.3);">
                  <button class="btn btn-sm manual-move-option" data-stage="pickup_awb_issued" style="width:100%;justify-content:flex-start;margin-bottom:4px;">Colete Ridicate</button>
                  <button class="btn btn-sm manual-move-option" data-stage="at_service" style="width:100%;justify-content:flex-start;margin-bottom:4px;">In Service</button>
                  <button class="btn btn-sm manual-move-option" data-stage="delivered_to_client" style="width:100%;justify-content:flex-start;">Inapoi la Client</button>
                </div>
              </div>
            ` : ''}
            ${ticket.section === 'retur' ? `
              <div style="position:absolute;top:16px;right:16px;">
                <button class="btn btn-sm" id="manualMoveBtn">↕ Mută tichetul manual</button>
                <div id="manualMoveMenu" style="display:none;position:absolute;top:calc(100% + 6px);right:0;background:var(--surface-raised);border:1px solid var(--border);border-radius:8px;padding:6px;min-width:190px;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,0.3);">
                  <button class="btn btn-sm manual-move-option" data-stage="pickup_awb_issued" style="width:100%;justify-content:flex-start;margin-bottom:4px;">Colete Ridicate</button>
                  <button class="btn btn-sm manual-move-option" data-stage="at_service" style="width:100%;justify-content:flex-start;margin-bottom:4px;">In așteptare IBAN</button>
                  <button class="btn btn-sm manual-move-option" data-stage="at_service" data-require-iban="1" style="width:100%;justify-content:flex-start;">Gata de Retur</button>
                </div>
              </div>
            ` : ''}
            <div class="t-id">${ticket.sectionCode ? escapeHtml(ticket.sectionCode) : ticket.id}</div>
            <h1>${escapeHtml(ticket.subject)}</h1>
            <div class="badges-row">
              <span class="badge badge-status-${ticket.status}">${STATUS_LABELS[ticket.status]}</span>
              <span class="badge badge-priority-${ticket.priority}">${PRIORITY_LABELS[ticket.priority]}</span>
              ${ticket.section === 'service' ? '<span class="badge badge-status-in_progress">🔧 Service</span>' : ''}
              ${ticket.section === 'retur' ? '<span class="badge badge-priority-urgent">↩ Retur</span>' : ''}
              ${ticket.refundPaidAt ? '<span class="badge" style="background:rgba(107,196,130,0.18);color:var(--status-resolved);border:1px solid rgba(107,196,130,0.4);">✓ Bani Returnați</span>' : ''}
              ${ticket.stage ? `<span class="badge" style="background:rgba(255,255,255,0.06);"><span class="status-pill-dot" style="background:${stageDotColor(ticket.stage)};"></span>${stageStatusLabel(ticket.stage, ticket.section)}</span>` : ''}
              ${computeDeadline(ticket) ? `<span class="badge" style="background:rgba(255,255,255,0.06);color:${isPastDeadline(ticket) ? 'var(--priority-urgent)' : 'var(--text-secondary)'};">⏱ ${fmtShortDate(computeDeadline(ticket))}</span>` : ''}
              ${relatedOrder ? `<span class="badge badge-status-waiting" id="relatedOrderLink" style="cursor:pointer;">📦 Comandă #${relatedOrder.mpId}</span>` : ''}
            </div>
            <div class="description">${escapeHtml(ticket.description)}</div>
            ${ticketPhotos.length ? `
              <div class="photo-thumbs" id="ticketPhotoGallery" style="margin-top:12px;">
                ${ticketPhotos.map((p) => `
                  <div class="photo-thumb-wrap" style="width:80px;height:80px;cursor:pointer;" data-photo-id="${p.id}">
                    <img src="/api/tickets/photos/${p.id}" alt="" loading="lazy" />
                  </div>
                `).join('')}
              </div>
            ` : ''}
            ${relatedOrder && relatedOrder.lineItems && relatedOrder.lineItems.length ? `
              <div class="line-items-list" style="margin-top:14px;">
                ${relatedOrder.lineItems.map((it) => `
                  <div class="line-item-row">
                    ${it.product_image_url
                      ? `<img class="li-thumb" src="${escapeHtml(it.product_image_url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'li-thumb li-thumb-placeholder',textContent:'—'}))" />`
                      : `<div class="li-thumb li-thumb-placeholder">—</div>`}
                    <div class="li-name">${escapeHtml(it.product_name || '—')}${it.product_sku ? ` <span style="color:var(--text-dim);">(${escapeHtml(it.product_sku)})</span>` : ''}</div>
                    <div class="li-qty">× ${it.quantity ?? 1}</div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            <div class="meta-row">
              <div class="meta-item"><div class="meta-label">Solicitant</div><div class="meta-value">${escapeHtml(ticket.requesterName)}</div></div>
              <div class="meta-item"><div class="meta-label">Telefon</div><div class="meta-value">${escapeHtml(ticket.requesterPhone || '—')}</div></div>
              <div class="meta-item"><div class="meta-label">Email</div><div class="meta-value">${escapeHtml(ticket.requesterEmail || '—')}</div></div>
              <div class="meta-item"><div class="meta-label">Creat</div><div class="meta-value">${fmtDate(ticket.createdAt)}</div></div>
              <div class="meta-item"><div class="meta-label">Actualizat</div><div class="meta-value">${fmtDate(ticket.updatedAt)}</div></div>
            </div>
          </div>

          <div class="side-panel" style="margin-bottom:16px;">
            ${(() => {
              const courierLabel = ticket.pickupAwbCourier === 'sameday' ? 'Sameday' : (ticket.pickupAwbCourier === 'gls' ? 'GLS' : null);
              const baseTitles = { service: 'AWB ridicare (client → service)', retur: 'Ridicare de la client', schimb: 'AWB colet la schimb' };
              const base = baseTitles[ticket.section] || 'AWB ridicare';
              return `<h2>${base}${courierLabel ? ` (${courierLabel})` : ''}</h2>`;
            })()}
            ${ticket.pickupAwbNumber ? `
              ${ticket.pickupAwbSecondaryNumber ? '<div class="sub" style="margin-bottom:6px;font-weight:600;">Tur (livrare produs nou)</div>' : ''}
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--border);">
                <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:600;">${escapeHtml(ticket.pickupAwbNumber)}</div>
                <div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-secondary);">
                  <span class="status-pill-dot" style="background:${stageDotColor(ticket.stage)};"></span>${stageLocationLabel(ticket.stage, ticket.section)}
                </div>
              </div>
              <div class="btn-row">
                <button class="btn btn-sm" id="refreshPickupStatusBtn">↻ Status</button>
                <button class="btn btn-sm" id="viewPickupTrackingBtn">Traseu</button>
                <button class="btn btn-sm" id="downloadPickupLabelBtn">↓ PDF</button>
                ${!ARRIVED_STAGES.includes(ticket.stage) ? '<button class="btn btn-sm" id="cancelPickupAwbBtn" style="color:var(--priority-urgent);">Anulează</button>' : ''}
              </div>
              <div id="pickupTrackingBox" style="display:none;margin-top:10px;"></div>
              ${ticket.pickupAwbSecondaryNumber ? `
                <div class="sub" style="margin:16px 0 6px;font-weight:600;">Retur (ridicare produs vechi)</div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--border);">
                  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:600;">${escapeHtml(ticket.pickupAwbSecondaryNumber)}</div>
                  <div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-secondary);">
                    <span class="status-pill-dot" style="background:${stageSecondaryDotColor(ticket.pickupAwbSecondaryStage)};"></span>${stageSecondaryStatusLabel(ticket.pickupAwbSecondaryStage, true)}
                  </div>
                </div>
                <div class="hint" style="margin-bottom:8px;">Generat automat de Sameday, odată cu AWB-ul de tur. Se anulează manual din panoul Sameday, dacă e cazul.</div>
                <div class="btn-row">
                  <button class="btn btn-sm" id="refreshSecondaryStatusBtn">↻ Status</button>
                  <button class="btn btn-sm" id="viewSecondaryTrackingBtn">Traseu</button>
                </div>
                <div id="secondaryTrackingBox" style="display:none;margin-top:10px;"></div>
              ` : ''}
            ` : `
              <form id="pickupAwbForm">
                <div class="form-row">
                  <div class="field-compact">
                    <label>Motiv ridicare *</label>
                    <select id="pu-reason" required>
                      <option value="service">Service / reparație</option>
                      <option value="retur">Retur produs</option>
                      <option value="schimb">Colet la schimb</option>
                    </select>
                  </div>
                  <div class="field-compact">
                    <label>Curier *</label>
                    <select id="pu-courier" required>
                      <option value="gls" ${glsConfigured ? '' : 'disabled'}>GLS${glsConfigured ? '' : ' (neconfigurat)'}</option>
                      <option value="sameday" ${samedayConfigured ? '' : 'disabled'}>Sameday${samedayConfigured ? '' : ' (neconfigurat)'}</option>
                    </select>
                  </div>
                </div>
                <div class="field-compact">
                  <label>Adresă ridicare *</label>
                  <input type="text" id="pu-address" required placeholder="Stradă, număr" value="${escapeHtml(relatedOrder?.shippingAddress || '')}" />
                </div>
                <div class="form-row">
                  <div class="field-compact">
                    <label>Oraș *</label>
                    <input type="text" id="pu-city" required value="${escapeHtml(relatedOrder?.shippingCity || '')}" />
                  </div>
                  <div class="field-compact">
                    <label>Cod poștal *</label>
                    <input type="text" id="pu-postal" required value="${escapeHtml(relatedOrder?.shippingPostalCode || '')}" />
                  </div>
                </div>
                <div class="field-compact">
                  <label>Telefon client *</label>
                  <input type="text" id="pu-phone" required value="${escapeHtml(relatedOrder?.shippingPhone || '')}" />
                </div>
                ${!glsConfigured && !samedayConfigured ? '<div class="hint" style="margin-bottom:8px;">Niciun curier nu este configurat pe server.</div>' : ''}
                <button class="btn btn-sm btn-block btn-primary" type="submit" ${glsConfigured || samedayConfigured ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>Generează AWB ridicare</button>
                ${relatedOrder ? '<div class="hint" style="margin-top:6px;">Adresa preluată automat din comanda asociată.</div>' : ''}
              </form>
            `}
          </div>

          ${ticket.section === 'service' && ticket.stage === 'at_service' && !ticket.returnAwbNumber ? `
            <div class="side-panel" style="margin-bottom:16px;">
              <div class="field-compact" style="margin-bottom:10px;">
                <label>Curier pentru AWB retur</label>
                <select id="return-courier">
                  <option value="gls" ${glsConfigured ? '' : 'disabled'}>GLS${glsConfigured ? '' : ' (neconfigurat)'}</option>
                  <option value="sameday" ${samedayConfigured ? '' : 'disabled'}>Sameday${samedayConfigured ? '' : ' (neconfigurat)'}</option>
                </select>
              </div>
              <button class="btn btn-sm btn-block" id="readyToShipBtn" style="background:var(--status-resolved);color:#fff;border-color:var(--status-resolved);font-weight:600;">✓ PRODUS REPARAT</button>
            </div>
          ` : ''}

          ${ticket.section === 'service' && (ticket.returnAwbNumber || ticket.stage === 'at_service') ? `
            <div class="side-panel" style="margin-bottom:16px;">
              <h2>AWB retur (service → client)</h2>
              ${ticket.returnAwbNumber ? `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--border);">
                  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:600;">${escapeHtml(ticket.returnAwbNumber)}</div>
                  <div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-secondary);">
                    <span class="status-pill-dot" style="background:${stageDotColor(ticket.stage)};"></span>${stageLocationLabel(ticket.stage, ticket.section)}
                  </div>
                </div>
                <div class="btn-row">
                  <button class="btn btn-sm" id="refreshReturnStatusBtn">↻ Status</button>
                  <button class="btn btn-sm" id="viewReturnTrackingBtn">Traseu</button>
                  <button class="btn btn-sm" id="downloadReturnLabelBtn">↓ PDF</button>
                  <button class="btn btn-sm" id="cancelReturnAwbBtn" style="color:var(--priority-urgent);">Anulează</button>
                </div>
                <div id="returnTrackingBox" style="display:none;margin-top:10px;"></div>
              ` : '<div class="hint">Apasă „PRODUS REPARAT" mai sus pentru a genera AWB-ul de retur către client.</div>'}
            </div>
          ` : ''}

          ${ticket.section === 'retur' ? `
            <div class="side-panel" style="margin-bottom:16px;">
              <h2>Rambursare — date bancare client</h2>
              <div class="form-row">
                <div class="field">
                  <label>IBAN *</label>
                  <input type="text" id="rf-iban" placeholder="RO49AAAA1B31007593840000" value="${escapeHtml(ticket.refundIban || '')}" style="font-family:var(--font-mono);text-transform:uppercase;" minlength="24" />
                </div>
                <div class="field">
                  <label>Titular cont</label>
                  <input type="text" id="rf-holder" placeholder="Implicit: numele clientului" value="${escapeHtml(ticket.refundAccountHolder || '')}" style="text-transform:uppercase;" />
                </div>
              </div>
              <div class="form-row">
                <div class="field">
                  <label>Sumă de returnat (RON) *</label>
                  <input type="number" id="rf-amount" step="0.01" min="0" placeholder="0.00" value="${ticket.refundAmount != null ? ticket.refundAmount : (relatedOrder ? relatedOrder.totalAmount : '')}" />
                </div>
              </div>
              <div class="field">
                <label>Motiv retur</label>
                <textarea id="rf-reason" placeholder="Ex: Produs cu defect de fabricație…" style="min-height:60px;text-transform:uppercase;">${escapeHtml(ticket.refundReason || '')}</textarea>
              </div>
              <button class="btn btn-block btn-primary" id="saveRefundInfoBtn" style="margin-bottom:10px;">Salvează datele bancare</button>
              ${ticket.refundIban && ticket.refundAmount != null ? `
                <div class="btn-row">
                  <button class="btn" id="downloadRefundPdfBtn">↓ Etichetă PDF</button>
                  <button class="btn" id="downloadRefundCsvBtn">↓ Exportă CSV (Excel)</button>
                  <button class="btn" id="cancelRefundInfoBtn" style="color:var(--priority-urgent);">Anulează datele bancare</button>
                </div>
              ` : '<div class="hint">Completează IBAN și suma, apoi salvează, ca să poți genera eticheta.</div>'}
            </div>
          ` : ''}

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

    const manualMoveBtn = content.querySelector('#manualMoveBtn');
    if (manualMoveBtn) {
      const manualMoveMenu = content.querySelector('#manualMoveMenu');
      manualMoveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        manualMoveMenu.style.display = manualMoveMenu.style.display === 'none' ? '' : 'none';
      });
      document.addEventListener('click', () => { manualMoveMenu.style.display = 'none'; }, { once: true });
      content.querySelectorAll('.manual-move-option').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.requireIban === '1' && !ticket.refundIban) {
            showToast('Completează IBAN-ul mai întâi.');
            return;
          }
          try {
            ticket = await api(`/api/tickets/${ticket.id}/set-stage`, { method: 'POST', body: JSON.stringify({ stage: btn.dataset.stage }) });
            showToast('Tichet mutat');
            paint();
          } catch (err) {
            showToast('Eroare: ' + err.message);
          }
        });
      });
    }

    content.querySelectorAll('#ticketPhotoGallery .photo-thumb-wrap[data-photo-id]').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        const photoId = thumb.dataset.photoId;
        const box = el(`
          <div style="text-align:center;">
            <img src="/api/tickets/photos/${photoId}" alt="" style="max-width:100%;max-height:70vh;border-radius:8px;" />
            <button class="btn" id="deletePhotoBtn" style="margin-top:14px;color:var(--priority-urgent);">Șterge fotografia</button>
          </div>
        `);
        openModal(box, { title: 'Fotografie tichet', restoreHistory: false });
        box.querySelector('#deletePhotoBtn').addEventListener('click', async () => {
          if (!confirm('Ștergi această fotografie?')) return;
          try {
            await api(`/api/tickets/photos/${photoId}`, { method: 'DELETE' });
            closeModal();
            ticketPhotos = ticketPhotos.filter((p) => p.id !== photoId);
            paint();
          } catch (err) {
            showToast('Eroare la ștergere: ' + err.message);
          }
        });
      });
    });

    const pickupForm = content.querySelector('#pickupAwbForm');
    if (pickupForm) {
      const courierSelect = content.querySelector('#pu-courier');

      pickupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = pickupForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Se generează…';
        const payload = {
          reason: content.querySelector('#pu-reason').value,
          courier: courierSelect.value,
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
        const courierLabel = ticket.pickupAwbCourier === 'sameday' ? 'Sameday' : 'GLS';
        if (!confirm(`Anulezi AWB-ul de ridicare ${ticket.pickupAwbNumber}? Această acțiune îl șterge și la ${courierLabel}.`)) return;
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

    // actualizare status (comuna pentru ridicare si retur -- backend-ul alege singur leg-ul activ)
    async function handleRefreshStatus(btn) {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Se verifică…';
      try {
        ticket = await api(`/api/tickets/${ticket.id}/refresh-awb-status`, { method: 'POST' });
        showToast('Status actualizat');
        paint();
      } catch (err) {
        showToast('Eroare: ' + err.message);
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    async function handleViewTracking(leg, box) {
      if (box.style.display === 'block') { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.innerHTML = '<div class="hint">Se încarcă…</div>';
      try {
        const events = await api(`/api/tickets/${ticket.id}/awb-tracking?leg=${leg}`);
        if (!events.length) {
          box.innerHTML = '<div class="hint">Niciun eveniment de tracking încă.</div>';
          return;
        }
        box.innerHTML = `
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;max-height:220px;overflow-y:auto;">
            ${events.map((e) => `
              <div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;">
                <div style="color:var(--text);">${escapeHtml(e.StatusDescription || '—')}</div>
                <div style="color:var(--text-dim);margin-top:2px;">${escapeHtml(e.DepotCity || '')} · ${e.StatusDate ? fmtDate(new Date(Number((e.StatusDate.match(/\d+/) || [0])[0])).toISOString()) : ''}</div>
              </div>
            `).join('')}
          </div>
        `;
      } catch (err) {
        box.innerHTML = `<div class="hint">Eroare: ${escapeHtml(err.message)}</div>`;
      }
    }

    const refreshPickupBtn = content.querySelector('#refreshPickupStatusBtn');
    if (refreshPickupBtn) refreshPickupBtn.addEventListener('click', () => handleRefreshStatus(refreshPickupBtn));

    const viewPickupTrackingBtn = content.querySelector('#viewPickupTrackingBtn');
    if (viewPickupTrackingBtn) {
      viewPickupTrackingBtn.addEventListener('click', () => handleViewTracking('pickup', content.querySelector('#pickupTrackingBox')));
    }

    const refreshSecondaryBtn = content.querySelector('#refreshSecondaryStatusBtn');
    const viewSecondaryTrackingBtn = content.querySelector('#viewSecondaryTrackingBtn');
    const secondaryTrackingBox = content.querySelector('#secondaryTrackingBox');
    if (refreshSecondaryBtn) {
      refreshSecondaryBtn.addEventListener('click', async () => {
        const original = refreshSecondaryBtn.textContent;
        refreshSecondaryBtn.disabled = true;
        refreshSecondaryBtn.textContent = 'Se verifică…';
        try {
          ticket = await api(`/api/tickets/${ticket.id}/refresh-secondary-status`, { method: 'POST' });
          showToast('Status retur actualizat');
          paint();
        } catch (err) {
          showToast('Eroare: ' + err.message);
          refreshSecondaryBtn.disabled = false;
          refreshSecondaryBtn.textContent = original;
        }
      });
    }
    if (viewSecondaryTrackingBtn && secondaryTrackingBox) {
      viewSecondaryTrackingBtn.addEventListener('click', () => handleViewTracking('secondary', secondaryTrackingBox));
    }

    const readyToShipBtn = content.querySelector('#readyToShipBtn');
    if (readyToShipBtn) {
      readyToShipBtn.addEventListener('click', async () => {
        const courier = content.querySelector('#return-courier').value;
        readyToShipBtn.disabled = true;
        readyToShipBtn.textContent = 'Se generează AWB retur…';
        try {
          ticket = await api(`/api/tickets/${ticket.id}/generate-return-awb`, { method: 'POST', body: JSON.stringify({ courier }) });
          showToast('AWB de retur generat — coletul e pe drum către client');
          paint();
        } catch (err) {
          showToast('Eroare: ' + err.message);
          readyToShipBtn.disabled = false;
          readyToShipBtn.textContent = '✓ PRODUS REPARAT';
        }
      });
    }

    const refreshReturnBtn = content.querySelector('#refreshReturnStatusBtn');
    if (refreshReturnBtn) refreshReturnBtn.addEventListener('click', () => handleRefreshStatus(refreshReturnBtn));

    const viewReturnTrackingBtn = content.querySelector('#viewReturnTrackingBtn');
    if (viewReturnTrackingBtn) {
      viewReturnTrackingBtn.addEventListener('click', () => handleViewTracking('return', content.querySelector('#returnTrackingBox')));
    }

    const downloadReturnBtn = content.querySelector('#downloadReturnLabelBtn');
    if (downloadReturnBtn) {
      downloadReturnBtn.addEventListener('click', () => {
        window.open(`/api/tickets/${ticket.id}/return-awb-label`, '_blank');
      });
    }

    const cancelReturnBtn = content.querySelector('#cancelReturnAwbBtn');
    if (cancelReturnBtn) {
      cancelReturnBtn.addEventListener('click', async () => {
        const returnCourierLabel = ticket.returnAwbCourier === 'sameday' ? 'Sameday' : 'GLS';
        if (!confirm(`Anulezi AWB-ul de retur ${ticket.returnAwbNumber}? Această acțiune îl șterge și la ${returnCourierLabel}.`)) return;
        cancelReturnBtn.disabled = true;
        try {
          ticket = await api(`/api/tickets/${ticket.id}/cancel-return-awb`, { method: 'POST' });
          showToast('AWB de retur anulat');
          paint();
        } catch (err) {
          showToast('Eroare la anulare: ' + err.message);
          cancelReturnBtn.disabled = false;
        }
      });
    }

    ['#rf-iban', '#rf-holder', '#rf-reason'].forEach((sel) => {
      const fieldEl = content.querySelector(sel);
      if (!fieldEl) return; // panoul de rambursare nu exista pentru tichete din afara Retur
      fieldEl.addEventListener('input', () => {
        const pos = fieldEl.selectionStart; // pastram pozitia cursorului, ca sa nu sara la final
        fieldEl.value = fieldEl.value.toUpperCase();
        fieldEl.setSelectionRange(pos, pos);
      });
    });

    const saveRefundInfoBtn = content.querySelector('#saveRefundInfoBtn');
    if (saveRefundInfoBtn) {
      saveRefundInfoBtn.addEventListener('click', async () => {
        const iban = content.querySelector('#rf-iban').value.trim();
        const holder = content.querySelector('#rf-holder').value.trim();
        const amount = content.querySelector('#rf-amount').value;
        const reason = content.querySelector('#rf-reason').value.trim();
        if (!iban) { showToast('Completează IBAN-ul.'); return; }
        if (iban.length < 24) { showToast('IBAN-ul trebuie să aibă minimum 24 de caractere.'); return; }
        if (!amount || Number(amount) <= 0) { showToast('Completează o sumă validă.'); return; }
        saveRefundInfoBtn.disabled = true;
        saveRefundInfoBtn.textContent = 'Se salvează…';
        try {
          ticket = await api(`/api/tickets/${ticket.id}/refund-info`, {
            method: 'PATCH',
            body: JSON.stringify({ iban, accountHolder: holder, amount: Number(amount), reason }),
          });
          showToast('Date bancare salvate');
          paint();
        } catch (err) {
          showToast('Eroare: ' + err.message);
          saveRefundInfoBtn.disabled = false;
          saveRefundInfoBtn.textContent = 'Salvează datele bancare';
        }
      });
    }

    async function markRefundPaidAndRepaint() {
      if (ticket.refundPaidAt) return; // deja marcat, nu mai facem un apel inutil
      try {
        ticket = await api(`/api/tickets/${ticket.id}/mark-refund-paid`, { method: 'POST' });
        paint();
      } catch (e) { /* n-o blocam pe utilizator daca marcarea esueaza */ }
    }

    const downloadRefundPdfBtn = content.querySelector('#downloadRefundPdfBtn');
    if (downloadRefundPdfBtn) {
      downloadRefundPdfBtn.addEventListener('click', () => {
        window.open(`/api/tickets/${ticket.id}/refund-label.pdf`, '_blank');
        markRefundPaidAndRepaint();
      });
    }
    const downloadRefundCsvBtn = content.querySelector('#downloadRefundCsvBtn');
    if (downloadRefundCsvBtn) {
      downloadRefundCsvBtn.addEventListener('click', () => {
        window.open(`/api/tickets/${ticket.id}/refund-label.csv`, '_blank');
        markRefundPaidAndRepaint();
      });
    }
    const cancelRefundInfoBtn = content.querySelector('#cancelRefundInfoBtn');
    if (cancelRefundInfoBtn) {
      cancelRefundInfoBtn.addEventListener('click', async () => {
        if (!confirm('Ștergi datele bancare salvate? Tichetul va reveni în „In așteptare IBAN".')) return;
        try {
          ticket = await api(`/api/tickets/${ticket.id}/refund-info`, { method: 'DELETE' });
          showToast('Date bancare șterse');
          paint();
        } catch (err) {
          showToast('Eroare: ' + err.message);
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

/** Comprimă o poză pe partea de client (redimensionare + JPEG) înainte de trimitere la server. */
function compressImageFile(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Nu am putut citi fișierul.'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Fișier imagine invalid.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('Comprimare eșuată.'));
          const reader2 = new FileReader();
          reader2.onload = () => resolve({ dataUrl: reader2.result, mimeType: 'image/jpeg' });
          reader2.onerror = () => reject(new Error('Comprimare eșuată.'));
          reader2.readAsDataURL(blob);
        }, 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

const MAX_NEW_TICKET_PHOTOS = 6;

async function paintNewTicketDrawer(fromOrderId) {
  let prefill = null;
  if (fromOrderId) {
    try {
      const order = await api(`/api/orders/${fromOrderId}`);
      const productNames = (order.lineItems || []).map((it) => it.product_name).filter(Boolean).join(', ');
      prefill = {
        requesterName: order.shippingName || order.billingName || '',
        requesterEmail: order.customerEmail || '',
        requesterPhone: order.shippingPhone || '',
        orderId: order.id,
        orderMpId: order.mpId,
        productNames,
      };
    } catch (e) {
      showToast('Nu am putut încărca datele comenzii: ' + e.message);
    }
  }

  const pendingPhotos = []; // { dataUrl, mimeType, base64 }
  const defaultCategory = categoriesCache.includes('Altele') ? 'Altele' : (categoriesCache[0] || '');

  const content = el(`
    <div class="modal-body">
      ${prefill ? `<div class="hint" style="margin-bottom:14px;">Comandă: <strong style="color:var(--text);">#${prefill.orderMpId}</strong>${prefill.productNames ? ` · Produs: <strong style="color:var(--text);">${escapeHtml(prefill.productNames)}</strong>` : ''}</div>` : ''}
      <form id="newForm">
        <div class="field">
          <label>Temă *</label>
          <input type="text" id="f-subject" required placeholder="Ex: Nu pot accesa contul" autofocus />
        </div>
        <div class="field">
          <label>Descriere *</label>
          <textarea id="f-description" required placeholder="Detaliază problema semnalată de client…"></textarea>
        </div>
        <div class="field">
          <label>Nume solicitant *</label>
          <input type="text" id="f-reqname" required placeholder="Ex: Vlad Marinescu" value="${prefill ? escapeHtml(prefill.requesterName) : ''}" />
        </div>
        <div class="form-row">
          <div class="field">
            <label>Telefon client</label>
            <input type="text" id="f-reqphone" placeholder="07xxxxxxxx" value="${prefill ? escapeHtml(prefill.requesterPhone) : ''}" />
          </div>
          <div class="field">
            <label>Email client</label>
            <input type="email" id="f-reqemail" placeholder="client@exemplu.ro" value="${prefill ? escapeHtml(prefill.requesterEmail) : ''}" />
          </div>
        </div>
        <div class="field">
          <label>Până la ${MAX_NEW_TICKET_PHOTOS} fotografii (opțional)</label>
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="file" id="f-photos-input" accept="image/*" multiple style="display:none;" />
            <button type="button" class="btn btn-sm" id="addPhotoBtn">📷+ Adaugă foto</button>
            <span class="hint" id="photoCount">0/${MAX_NEW_TICKET_PHOTOS}</span>
          </div>
          <div class="photo-thumbs" id="photoThumbs"></div>
        </div>
        <label class="checkbox-label" style="margin-bottom:16px;">
          <input type="checkbox" id="f-urgent" /> Urgent
        </label>
        <div class="form-actions">
          <button class="btn btn-ghost" type="button" id="cancelBtn">Anulează</button>
          <button class="btn btn-primary" type="submit">Salvează</button>
        </div>
      </form>
    </div>
  `);
  content.querySelector('#newForm').dataset.defaultCategory = defaultCategory;
  openModal(content, { title: 'Tichet nou' });

  const photoInput = content.querySelector('#f-photos-input');
  const photoThumbs = content.querySelector('#photoThumbs');
  const photoCount = content.querySelector('#photoCount');
  const addPhotoBtn = content.querySelector('#addPhotoBtn');

  function renderThumbs() {
    photoCount.textContent = `${pendingPhotos.length}/${MAX_NEW_TICKET_PHOTOS}`;
    addPhotoBtn.disabled = pendingPhotos.length >= MAX_NEW_TICKET_PHOTOS;
    photoThumbs.innerHTML = pendingPhotos.map((p, idx) => `
      <div class="photo-thumb-wrap" data-idx="${idx}">
        <img src="${p.dataUrl}" alt="" />
        <button type="button" class="photo-thumb-remove" data-idx="${idx}" title="Elimină">✕</button>
      </div>
    `).join('');
    photoThumbs.querySelectorAll('.photo-thumb-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingPhotos.splice(Number(btn.dataset.idx), 1);
        renderThumbs();
      });
    });
  }

  addPhotoBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const files = Array.from(photoInput.files || []).slice(0, MAX_NEW_TICKET_PHOTOS - pendingPhotos.length);
    for (const file of files) {
      try {
        const { dataUrl, mimeType } = await compressImageFile(file);
        pendingPhotos.push({ dataUrl, mimeType, base64: dataUrl.split(',')[1] });
      } catch (e) {
        showToast('Eroare la procesarea unei fotografii: ' + e.message);
      }
    }
    photoInput.value = '';
    renderThumbs();
  });

  content.querySelector('#cancelBtn').addEventListener('click', () => closeModal());

  content.querySelector('#newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = content.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Se salvează…';
    const payload = {
      subject: content.querySelector('#f-subject').value.trim(),
      description: content.querySelector('#f-description').value.trim(),
      requesterName: content.querySelector('#f-reqname').value.trim(),
      requesterEmail: content.querySelector('#f-reqemail').value.trim(),
      requesterPhone: content.querySelector('#f-reqphone').value.trim(),
      category: content.querySelector('#newForm').dataset.defaultCategory,
      priority: content.querySelector('#f-urgent').checked ? 'urgent' : 'medium',
      relatedOrderId: prefill ? prefill.orderId : null,
    };
    try {
      const ticket = await api('/api/tickets', { method: 'POST', body: JSON.stringify(payload) });
      for (const p of pendingPhotos) {
        try {
          await api(`/api/tickets/${ticket.id}/photos`, { method: 'POST', body: JSON.stringify({ dataBase64: p.base64, mimeType: p.mimeType }) });
        } catch (err) {
          showToast('O fotografie nu a putut fi încărcată: ' + err.message);
        }
      }
      showToast('Tichet creat cu succes');
      closeModal();
      if (currentMainRoute !== '#/tickets') await renderBackgroundForRoute('#/tickets');
      history.pushState(null, '', `#/tickets/${ticket.id}`);
      await paintTicketDrawer(await api(`/api/tickets/${ticket.id}`));
    } catch (err) {
      showToast('Eroare: ' + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Salvează';
    }
  });
}


// ---------------- Comenzi (MerchantPro) ----------------

function fmtMoney(amount, currency) {
  if (amount === null || amount === undefined) return '—';
  return `${Number(amount).toFixed(2)} ${currency || ''}`.trim();
}

/** Etichetă scurtă pentru metoda de plată — "Ramburs" pentru plata cash la curier. */
function paymentMethodLabel(order) {
  if (order.paymentMethodCode === 'cash_delivery') return 'Ramburs';
  const name = order.paymentMethodName || '';
  if (/ramburs|cash.*delivery|cash.*curier/i.test(name)) return 'Ramburs';
  if (/card/i.test(name)) return 'CARD';
  return name || '—';
}

async function renderOrdersList() {
  const filters = parseListRoute(window.location.hash);

  // implicit: "Azi" -- daca nu exista niciun filtru de data si nici alegerea explicita "Toate"
  if (!filters.dateFrom && !filters.dateTo && filters.period !== 'all') {
    const today = computePeriodRange('today');
    const params = new URLSearchParams({ ...filters, dateFrom: today.dateFrom, dateTo: today.dateTo });
    navigate(`#/orders?${params.toString()}`);
    return;
  }

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
      <div class="filters-search-row">
        <input type="text" id="q" placeholder="Caută client, oraș, ID comandă, telefon, AWB…" value="${escapeHtml(filters.q || '')}" />
      </div>
      <div class="status-pills-label">Perioadă</div>
      <div id="periodPickerContainer"></div>
      <div class="status-pills-label">Status livrare</div>
      <div class="status-pills" id="statusPills"></div>
      <div class="status-pills-label">Status plată</div>
      <div class="status-pills" id="paymentPills"></div>
      <div class="status-pills-label">AWB</div>
      <div class="status-pills" id="awbPills"></div>
      <div id="orders-body">Se încarcă…</div>
    </div>
  `);
  renderShell('#/orders', content);

  renderPeriodPicker(content.querySelector('#periodPickerContainer'), filters, (range) => applyFiltersFromForm(range));

  // ---- cele trei cereri independente, in PARALEL (nu secvential) --
  // reduce timpul total de asteptare la cel al celei mai lente dintre ele,
  // nu la suma tuturor (asa cum erau inainte, una dupa alta)
  const statsQuery = new URLSearchParams();
  if (filters.dateFrom) statsQuery.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) statsQuery.set('dateTo', filters.dateTo);
  const apiFilters = { ...filters };
  const query = new URLSearchParams(apiFilters).toString();

  const [syncStatusResult, statsResult, ordersResult] = await Promise.allSettled([
    api('/api/orders/sync-status'),
    api(`/api/orders/stats?${statsQuery.toString()}`),
    api(`/api/orders?${query}`),
  ]);

  if (syncStatusResult.status === 'fulfilled') {
    const syncStatus = syncStatusResult.value;
    platformLabel = syncStatus.platformLabel || 'MERCHANTPRO';
    const banner = content.querySelector('#sync-banner');
    if (syncStatus.lastSyncResult) {
      const r = syncStatus.lastSyncResult;
      banner.innerHTML = `<div style="color:var(--text-dim);font-size:12px;margin-bottom:14px;">Ultima sincronizare: ${fmtDate(r.at)} · ${r.created} noi, ${r.updated} actualizate</div>`;
    }
  } // altfel: n-o afisam ca eroare blocanta

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

  // statistici + pastile pentru toate filtrele
  function applyFiltersFromForm(overrides = {}) {
    const params = new URLSearchParams();
    const q = content.querySelector('#q').value.trim();
    const merged = {
      shippingStatus: filters.shippingStatus || '',
      paymentStatus: filters.paymentStatus || '',
      internalStatus: filters.internalStatus || '',
      assignedTo: filters.assignedTo || '',
      needsAwb: filters.needsAwb || '',
      dateFrom: filters.dateFrom || '',
      dateTo: filters.dateTo || '',
      period: filters.period || '',
      ...overrides,
    };
    if (q) params.set('q', q);
    if (merged.shippingStatus) params.set('shippingStatus', merged.shippingStatus);
    if (merged.paymentStatus) params.set('paymentStatus', merged.paymentStatus);
    if (merged.internalStatus) params.set('internalStatus', merged.internalStatus);
    if (merged.assignedTo) params.set('assignedTo', merged.assignedTo);
    if (merged.needsAwb) params.set('needsAwb', merged.needsAwb);
    if (merged.dateFrom) params.set('dateFrom', merged.dateFrom);
    if (merged.dateTo) params.set('dateTo', merged.dateTo);
    if (merged.period) params.set('period', merged.period);
    navigate(`#/orders?${params.toString()}`);
  }

  let qTimer;
  content.querySelector('#q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => applyFiltersFromForm(), 350);
  });

  function buildPillRow(containerId, { activeValue, filterKey, allLabel, entries }) {
    const html = [
      `<button class="status-pill ${!activeValue ? 'active' : ''}" data-value="">↺ ${allLabel}</button>`,
      ...entries.map(({ value, label, count, dot }) =>
        `<button class="status-pill ${activeValue === value ? 'active' : ''}" data-value="${value}">${dot ? `<span class="status-pill-dot" style="background:${dot}"></span>` : ''}${label}<span class="status-pill-count">${count}</span></button>`
      ),
    ].join('');
    const container = content.querySelector(containerId);
    container.innerHTML = html;
    container.querySelectorAll('.status-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const clickedValue = pill.dataset.value;
        const newValue = clickedValue && clickedValue === activeValue ? '' : clickedValue;
        applyFiltersFromForm({ [filterKey]: newValue });
      });
    });
  }

  if (statsResult.status === 'fulfilled') {
    const stats = statsResult.value;
    const PERIOD_SUBLABEL = { all: 'toate perioadele', today: 'azi', week: 'săptămâna aceasta', month: 'luna aceasta', custom: 'perioadă personalizată' };
    const activePeriodLabel = PERIOD_SUBLABEL[detectActivePeriod(filters.dateFrom, filters.dateTo)];
    content.querySelector('#order-stats').innerHTML = `
      <div class="stat-tile accented"><span class="corner-dot" style="background:var(--accent);"></span><div class="label">Total comenzi</div><div class="value">${stats.total}</div><div class="sub-line">${activePeriodLabel}</div></div>
      <div class="stat-tile"><span class="corner-dot glow-dot" style="background:var(--status-resolved);"></span><div class="label">Expediate</div><div class="value">${stats.shipped}</div><div class="sub-line">${activePeriodLabel}</div></div>
      <div class="stat-tile"><span class="corner-dot" style="background:var(--priority-urgent);"></span><div class="label">Anulate</div><div class="value">${stats.cancelled}</div><div class="sub-line">${activePeriodLabel}</div></div>
    `;

    const shippingDotVar = {
      awaiting: 'var(--status-open)', confirmed: 'var(--accent)', in_process: 'var(--status-waiting)',
      shipped: 'var(--status-in_progress)', delivered: 'var(--status-resolved)',
      returned: 'var(--status-closed)', cancelled: 'var(--priority-urgent)',
    };
    buildPillRow('#statusPills', {
      activeValue: filters.shippingStatus || '', filterKey: 'shippingStatus', allLabel: 'Toate',
      entries: Object.entries(SHIPPING_STATUS_LABELS_MP).map(([v, l]) => ({ value: v, label: l, count: stats.byShippingStatus[v] || 0, dot: shippingDotVar[v] })),
    });

    const paymentDotVar = {
      temporary: 'var(--status-closed)', awaiting: 'var(--status-open)', paid: 'var(--status-resolved)',
      failed: 'var(--priority-urgent)', canceled: 'var(--status-closed)', refunded: 'var(--status-waiting)', rejected: 'var(--priority-urgent)',
    };
    buildPillRow('#paymentPills', {
      activeValue: filters.paymentStatus || '', filterKey: 'paymentStatus', allLabel: 'Toate',
      entries: Object.entries(PAYMENT_STATUS_LABELS_MP).map(([v, l]) => ({ value: v, label: l, count: stats.byPaymentStatus[v] || 0, dot: paymentDotVar[v] })),
    });

    buildPillRow('#awbPills', {
      activeValue: filters.needsAwb || '', filterKey: 'needsAwb', allLabel: 'Toate',
      entries: [
        { value: '1', label: 'Fără AWB', count: stats.needsAwb, dot: 'var(--priority-high)' },
        { value: '0', label: 'Cu AWB', count: stats.withAwb, dot: 'var(--status-resolved)' },
      ],
    });
  } // altfel: n-o afisam ca eroare blocanta

  const listBody = content.querySelector('#orders-body');
  let orders;
  if (ordersResult.status === 'fulfilled') {
    orders = ordersResult.value;
  } else {
    listBody.innerHTML = `<div class="panel">Eroare la încărcarea comenzilor: ${escapeHtml(ordersResult.reason.message)}</div>`;
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
    const thumbs = (o.lineItems || []).slice(0, 3).map((it) => {
      const qtyBadge = it.quantity > 1 ? `<span class="thumb-qty-badge">×${it.quantity}</span>` : '';
      const productName = it.product_name || '';
      const img = it.product_image_url
        ? `<img class="order-thumb" src="${escapeHtml(it.product_image_url)}" alt="" title="${escapeHtml(productName)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'order-thumb order-thumb-placeholder',textContent:'—'}))" />`
        : `<div class="order-thumb order-thumb-placeholder" title="${escapeHtml(productName)}">—</div>`;
      return `<span class="order-thumb-wrap">${img}${qtyBadge}</span>`;
    }).join('');
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
      <div style="min-width:0;overflow:hidden;display:flex;align-items:center;gap:6px;">
        ${o.paymentStatus === 'paid' ? '<span class="glow-dot" title="Plată finalizată"></span>' : ''}
        <span class="badge badge-status-closed" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(paymentMethodLabel(o))}</span>
      </div>
      <div class="order-awb-status">
        <div class="awb-status-line"><span class="awb-status-dot ${o.awbNumber || o.shippingAwb ? 'has-awb' : ''}"></span>${o.awbNumber || o.shippingAwb ? 'AWB emis' : 'Fără AWB'}</div>
        <div class="awb-status-sub">${escapeHtml(SHIPPING_STATUS_LABELS_MP[o.shippingStatus] || o.shippingStatusText || o.shippingStatus || '—')}</div>
      </div>
      <div class="order-invoice">${o.invoice && !o.invoice.cancelled ? `<span class="invoice-badge">${escapeHtml(o.invoice.prefix || '')}.${escapeHtml(o.invoice.number || '')}</span>` : '<span style="color:var(--text-dim);">—</span>'}</div>
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

    content.innerHTML = `
      <div class="order-header-v2">
        <div>
          <div class="t-id">Detalii comandă</div>
          <h1>#${order.mpId}</h1>
        </div>
      </div>

      <div class="badges-row" style="align-items:center;margin-bottom:16px;flex-wrap:wrap;">
        <span class="badge"><span class="platform-dot"></span>${escapeHtml(platformLabel)}</span>
        <span class="badge badge-status-closed">${escapeHtml(paymentMethodLabel(order))}</span>
        <span class="badge ${paymentBadgeClass(order.paymentStatus)}">${PAYMENT_STATUS_LABELS_MP[order.paymentStatus] || order.paymentStatus || '—'}</span>
        <span class="badge ${shippingBadgeClass(order.shippingStatus)}">${SHIPPING_STATUS_LABELS_MP[order.shippingStatus] || order.shippingStatusText || order.shippingStatus || '—'}</span>
        ${order.shippingAwb ? `<span class="badge" id="awbCopyBadge" style="cursor:pointer;" title="Click pentru a copia numărul AWB">📦 ${escapeHtml(order.shippingAwb)}</span>` : ''}
        ${order.invoice && !order.invoice.cancelled
          ? (order.invoice.url
              ? `<a href="${escapeHtml(order.invoice.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-solid-green" style="text-decoration:none;">📄 ${escapeHtml(order.invoice.prefix || '')} ${escapeHtml(order.invoice.number || '')}</a>`
              : `<span class="btn btn-sm btn-solid-green">📄 ${escapeHtml(order.invoice.prefix || '')} ${escapeHtml(order.invoice.number || '')}</span>`)
          : `<button class="btn btn-sm" id="issueInvoiceBtn">Emite factură</button>`}
        <div style="flex:1;"></div>
        <div style="font-size:22px;font-weight:700;">${fmtMoney(order.totalAmount, order.currency)}</div>
      </div>

      <div class="comments-panel" style="margin-bottom:16px;">
        <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);margin:0 0 10px;">Produse comandate</h2>
        <div class="line-items-list">${items}</div>
        ${(order.shippingCost != null || order.totalAmount != null) ? `
          <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px;display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
            ${order.shippingCost != null ? `<div style="font-size:13px;color:var(--text-secondary);">Transport: ${fmtMoney(order.shippingCost, order.currency)}</div>` : ''}
            <div style="font-size:15px;font-weight:700;">Total comandă: ${fmtMoney(order.totalAmount, order.currency)}</div>
          </div>
        ` : ''}
      </div>

      <div class="order-two-col">
        <div class="order-col-left">
          <div class="side-panel">
            <h2>Client</h2>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Nume:</span> ${escapeHtml(order.shippingName || order.billingName || '—')}</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Telefon:</span> ${escapeHtml(order.shippingPhone || '—')}</div>
            <div style="font-size:13px;padding:2px 0 8px;"><span style="color:var(--text-dim);">Email:</span> ${escapeHtml(order.customerEmail || '—')}</div>
            <button class="btn btn-sm" id="clientProfileBtn">👤 Profil client</button>

            <div style="border-top:1px solid var(--border);margin:12px 0 8px;padding-top:10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim);">Facturare</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Nume:</span> ${escapeHtml(order.billingName || '—')}</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Adresă:</span> ${escapeHtml(order.billingAddress || '—')}</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Localitate:</span> ${escapeHtml(order.billingCity || '—')}${order.billingState ? `, ${escapeHtml(order.billingState)}` : ''}${order.billingPostalCode ? ` · ${escapeHtml(order.billingPostalCode)}` : ''}</div>

            <div style="border-top:1px solid var(--border);margin:12px 0 8px;padding-top:10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim);">Livrare</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Metodă:</span> ${escapeHtml(order.shippingMethodName || '—')}</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Adresă:</span> ${escapeHtml(order.shippingAddress || '—')}</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Localitate:</span> ${escapeHtml(order.shippingCity || '—')}${order.shippingState ? `, ${escapeHtml(order.shippingState)}` : ''}${order.shippingPostalCode ? ` · ${escapeHtml(order.shippingPostalCode)}` : ''}</div>
            <div style="font-size:13px;padding:2px 0;"><span style="color:var(--text-dim);">Comandă creată:</span> ${fmtDate(order.dateCreated)}</div>
          </div>
        </div>


        <div class="order-col-right">
          <div class="side-panel">
            <h2>Activitate</h2>
            <div class="btn-row" style="margin-bottom:14px;">
              <button class="btn btn-sm btn-outline-blue" id="quickNoteBtn">+ Notă</button>
              <button class="btn btn-sm btn-solid-green" id="openTicketBtn">+ Tichet nou</button>
            </div>

            <form class="comment-form" id="noteForm" style="display:none;margin-bottom:16px;">
              <textarea id="noteBody" placeholder="Adaugă o notiță pentru echipă…" required></textarea>
              <div class="comment-form-actions" style="justify-content:flex-end;">
                <button class="btn btn-sm" type="button" id="cancelNoteBtn">Anulează</button>
                <button class="btn btn-primary btn-sm" type="submit">Adaugă notiță</button>
              </div>
            </form>

            <div class="activity-feed">
              ${buildOrderActivityFeed(order, linkedTickets)}
            </div>
          </div>
        </div>
      </div>
    `;

    content.querySelector('#openTicketBtn').addEventListener('click', () => openNewTicketDrawer(order.id));
    content.querySelectorAll('.activity-ticket-link[data-tid]').forEach((item) => {
      item.addEventListener('click', () => openTicketDrawerCrossLink(item.dataset.tid));
    });

    const awbCopyBadge = content.querySelector('#awbCopyBadge');
    if (awbCopyBadge) {
      awbCopyBadge.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(order.shippingAwb);
          showToast('Număr AWB copiat');
        } catch (e) {
          showToast('Nu am putut copia — copiază manual: ' + order.shippingAwb);
        }
      });
    }

    content.querySelector('#clientProfileBtn').addEventListener('click', () => {
      openClientProfileDrawer({ phone: order.shippingPhone, email: order.customerEmail, name: order.shippingName || order.billingName });
    });

    const quickNoteBtn = content.querySelector('#quickNoteBtn');
    const noteForm = content.querySelector('#noteForm');
    quickNoteBtn.addEventListener('click', () => {
      noteForm.style.display = 'block';
      quickNoteBtn.style.display = 'none';
      content.querySelector('#noteBody').focus();
    });
    content.querySelector('#cancelNoteBtn').addEventListener('click', () => {
      noteForm.style.display = 'none';
      quickNoteBtn.style.display = '';
      content.querySelector('#noteBody').value = '';
    });

    const issueInvoiceBtn = content.querySelector('#issueInvoiceBtn');
    if (issueInvoiceBtn) {
      issueInvoiceBtn.addEventListener('click', async () => {
        issueInvoiceBtn.disabled = true;
        issueInvoiceBtn.textContent = 'Se emite…';
        try {
          order = await api(`/api/orders/${order.id}/issue-invoice`, { method: 'POST' });
          showToast('Factură emisă cu succes');
          paint();
        } catch (err) {
          showToast('Eroare la emiterea facturii: ' + err.message);
          issueInvoiceBtn.disabled = false;
          issueInvoiceBtn.textContent = 'Emite factură';
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

/** Construieste feed-ul unificat de activitate pentru o comanda: creare + notite, grupate pe zi. */
function buildOrderActivityFeed(order, linkedTickets) {
  const events = [
    { type: 'created', at: order.dateCreated, label: 'Comandă creată', by: 'system' },
    ...order.notes.map((n) => ({ type: 'note', at: n.createdAt, label: n.body, by: n.agentName })),
    ...linkedTickets.map((t) => ({ type: 'ticket', at: t.createdAt, label: `Tichet deschis: ${t.subject}`, by: t.requesterName, tid: t.id })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  let lastDateKey = null;
  const rows = events.map((e) => {
    const d = new Date(e.at);
    const dateKey = d.toDateString();
    const dateHeader = dateKey !== lastDateKey ? `<div class="activity-date-sep">${fmtActivityDate(d)}</div>` : '';
    lastDateKey = dateKey;
    const icon = { created: '＋', note: '📝', ticket: '🎫' }[e.type] || '•';
    const clickable = e.type === 'ticket' ? `class="activity-ticket-link" data-tid="${e.tid}" style="cursor:pointer;"` : '';
    return `
      ${dateHeader}
      <div class="activity-row" ${clickable}>
        <span class="activity-icon">${icon}</span>
        <div class="activity-body">
          <div class="activity-label">${escapeHtml(e.label)}</div>
          <div class="activity-by">${escapeHtml(e.by)}</div>
        </div>
        <div class="activity-time">${d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `;
  }).join('');

  return rows || '<div class="hint">Nicio activitate încă.</div>';
}

function fmtActivityDate(d) {
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const label = d.toLocaleDateString('ro-RO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return isToday ? `Azi · ${label}` : label;
}

/** Deschide tichetul asociat unei comenzi, comutând fundalul la lista de tichete corectă. */
async function openTicketDrawerCrossLink(ticketId) {
  let ticket;
  try { ticket = await api(`/api/tickets/${ticketId}`); } catch (e) { showToast('Tichet negăsit'); return; }
  const bgRoute = { service: '#/service', retur: '#/retur', schimb: '#/schimb' }[ticket.section] || '#/tickets';
  if (currentMainRoute !== bgRoute) await renderBackgroundForRoute(bgRoute);
  history.pushState(null, '', `#/tickets/${ticketId}`);
  await paintTicketDrawer(ticket);
}

/** Deschide comanda asociată unui tichet, comutând fundalul la lista de comenzi. */
async function openOrderDrawerCrossLink(orderId) {
  if (currentMainRoute !== '#/orders') await renderOrdersList();
  history.pushState(null, '', `#/orders/${orderId}`);
  await openOrderDrawer(orderId);
}

/** Profil client "virtual" — agregă toate comenzile și tichetele cu același telefon/email. */
async function openClientProfileDrawer({ phone, email, name }) {
  const content = el(`<div><div class="hint">Se încarcă profilul clientului…</div></div>`);
  openDrawer(content);

  const params = new URLSearchParams();
  if (phone) params.set('phone', phone);
  if (email) params.set('email', email);

  let profile;
  try {
    profile = await api(`/api/clients/lookup?${params.toString()}`);
  } catch (e) {
    content.innerHTML = `<div class="panel">Eroare la încărcarea profilului: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const displayName = profile.name || name || 'Client necunoscut';
  content.innerHTML = `
    <div class="ticket-header-card" style="margin-bottom:16px;">
      <div class="t-id">PROFIL CLIENT</div>
      <h1>${escapeHtml(displayName)}</h1>
      <div class="description" style="color:var(--text-secondary);">
        ${profile.phone ? `📞 ${escapeHtml(profile.phone)}` : ''}${profile.phone && profile.email ? '  ·  ' : ''}${profile.email ? `✉ ${escapeHtml(profile.email)}` : ''}
        ${!profile.phone && !profile.email ? 'Fără date de contact suficiente pentru căutare.' : ''}
      </div>
    </div>

    <div class="side-panel" style="margin-bottom:16px;">
      <h2>Comenzi (${profile.orders.length})</h2>
      ${profile.orders.length ? profile.orders.map((o) => `
        <div class="queue-item" data-oid="${o.id}" style="cursor:pointer;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>#${o.mpId}</strong>
            <span style="font-family:var(--font-mono);">${fmtMoney(o.totalAmount, o.currency)}</span>
          </div>
          <div class="hint">${SHIPPING_STATUS_LABELS_MP[o.shippingStatus] || o.shippingStatusText || o.shippingStatus || '—'} · ${fmtDate(o.dateCreated)}</div>
        </div>
      `).join('') : '<div class="hint">Nicio comandă găsită pentru acest client.</div>'}
    </div>

    <div class="side-panel">
      <h2>Tichete (${profile.tickets.length})</h2>
      ${profile.tickets.length ? profile.tickets.map((t) => `
        <div class="queue-item" data-tid="${t.id}" style="cursor:pointer;">
          <strong>${escapeHtml(t.sectionCode || t.id)}</strong> — ${escapeHtml(t.subject)}
          <div class="hint">${STATUS_LABELS[t.status]} · ${fmtDate(t.createdAt)}</div>
        </div>
      `).join('') : '<div class="hint">Niciun tichet găsit pentru acest client.</div>'}
    </div>
  `;

  content.querySelectorAll('.queue-item[data-oid]').forEach((item) => {
    item.addEventListener('click', () => openOrderDrawerCrossLink(item.dataset.oid));
  });
  content.querySelectorAll('.queue-item[data-tid]').forEach((item) => {
    item.addEventListener('click', () => openTicketDrawerCrossLink(item.dataset.tid));
  });
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
        <button class="admin-tab" data-tab="integrations">Integrări</button>
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
    else if (activeTab === 'categories') await paintCategories();
    else await paintIntegrations();
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
        agentsCache = await api('/api/admin/agents');
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
            agentsCache = await api('/api/admin/agents');
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

  async function paintIntegrations() {
    body.innerHTML = 'Se încarcă…';
    let s;
    try {
      s = await api('/api/company/settings');
    } catch (e) {
      body.innerHTML = `<div class="panel">Eroare: ${escapeHtml(e.message)}</div>`;
      return;
    }

    const INTEGRATIONS = [
      { key: 'merchantpro', label: 'MerchantPro', activeField: 'merchantProActive', configured: Boolean(s.merchantProShopUrl && s.merchantProApiKey && s.merchantProApiSecretSet) },
      { key: 'gomag', label: 'GoMag', activeField: 'gomagActive', configured: Boolean(s.gomagShopUrl && s.gomagApiKeySet) },
      { key: 'gls', label: 'GLS', activeField: 'glsActive', configured: Boolean(s.glsUsername && s.glsPasswordSet) },
      { key: 'sameday', label: 'Sameday', activeField: 'samedayActive', configured: Boolean(s.samedayUsername && s.samedayPasswordSet) },
    ];

    body.innerHTML = `
      <div class="panel">
        <h2>Integrări active</h2>
        <div class="hint" style="margin-bottom:14px;">Oprește temporar o integrare, fără să ștergi datele de conectare — util dacă vrei să pui pauză unei platforme sau unui curier, fără să reconfigurezi totul mai târziu.</div>
        ${INTEGRATIONS.map((i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);">
            <div>
              <div style="font-weight:500;">${i.label}</div>
              <div class="hint" style="margin-top:2px;">${i.configured ? `<span style="color:${s[i.activeField] ? 'var(--status-resolved)' : 'var(--priority-urgent)'};">${s[i.activeField] ? '✓ Activă' : '✕ Dezactivată'}</span>` : 'Necompletată încă, în Setări'}</div>
            </div>
            <button class="btn btn-sm integration-toggle-btn" data-key="${i.key}" data-active="${s[i.activeField] ? 'true' : 'false'}" style="width:120px;${!i.configured ? 'opacity:0.5;pointer-events:none;' : ''}${s[i.activeField] ? 'color:var(--priority-urgent);' : 'color:var(--status-resolved);'}">${s[i.activeField] ? 'Dezactivează' : 'Activează'}</button>
          </div>
        `).join('')}
      </div>
    `;

    body.querySelectorAll('.integration-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        const newActive = btn.dataset.active !== 'true';
        btn.disabled = true;
        try {
          await api(`/api/company/integrations/${key}/active`, { method: 'POST', body: JSON.stringify({ active: newActive }) });
          showToast(newActive ? 'Integrare activată' : 'Integrare dezactivată');
          paintIntegrations();
        } catch (e) {
          showToast('Eroare: ' + e.message);
          btn.disabled = false;
        }
      });
    });
  }

  paintTab();
}

// ---------------- Setari companie (credentiale curieri/MerchantPro, doar manageri) ----------------

async function renderSettings() {
  if (currentAgent.role !== 'manager') {
    navigate('#/dashboard');
    return;
  }

  const content = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Setări</h1>
          <div class="sub">Credențialele MerchantPro, GLS și Sameday ale companiei tale</div>
        </div>
      </div>
      <div id="settings-body">Se încarcă…</div>
    </div>
  `);
  renderShell('#/settings', content);

  const body = content.querySelector('#settings-body');
  let s;
  try {
    s = await api('/api/company/settings');
  } catch (e) {
    body.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    return;
  }

  const v = (x) => escapeHtml(x || '');

  body.innerHTML = '';
  body.appendChild(el(`
    <form id="settingsForm">
      <div class="panel" style="margin-bottom:20px;">
        <h2>MerchantPro</h2>
        <div class="field">
          <label>URL magazin</label>
          <input type="text" id="s-mp-url" placeholder="https://magazinul-tau.ro/" value="${v(s.merchantProShopUrl)}" />
        </div>
        <div class="form-row">
          <div class="field">
            <label>Cheie API (API Key)</label>
            <input type="text" id="s-mp-key" value="${v(s.merchantProApiKey)}" />
          </div>
          <div class="field">
            <label>Secret API${s.merchantProApiSecretSet ? ' — setat ✓' : ''}</label>
            <input type="password" id="s-mp-secret" placeholder="${s.merchantProApiSecretSet ? '••••••••  (lasă gol ca să păstrezi)' : 'Introdu secretul API'}" />
          </div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:20px;">
        <h2>GoMag</h2>
        <div class="form-row">
          <div class="field">
            <label>URL magazin</label>
            <input type="text" id="s-gomag-url" placeholder="https://magazinul-tau.gomag.ro" value="${v(s.gomagShopUrl)}" />
          </div>
          <div class="field">
            <label>Cheie API${s.gomagApiKeySet ? ' — setată ✓' : ''}</label>
            <input type="password" id="s-gomag-key" placeholder="${s.gomagApiKeySet ? '••••••••  (lasă gol ca să păstrezi)' : 'Introdu cheia API'}" />
          </div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:20px;">
        <h2>GLS</h2>
        <div class="form-row">
          <div class="field">
            <label>Utilizator</label>
            <input type="text" id="s-gls-user" value="${v(s.glsUsername)}" />
          </div>
          <div class="field">
            <label>Parolă${s.glsPasswordSet ? ' — setată ✓' : ''}</label>
            <input type="password" id="s-gls-pass" placeholder="${s.glsPasswordSet ? '••••••••  (lasă gol ca să păstrezi)' : 'Introdu parola'}" />
          </div>
        </div>
        <div class="field">
          <label>Număr client GLS</label>
          <input type="text" id="s-gls-client" value="${v(s.glsClientNumber)}" />
        </div>
        <div class="sub" style="margin:16px 0 8px;">Date expeditor (apar pe etichetele GLS)</div>
        <div class="form-row">
          <div class="field">
            <label>Nume firmă</label>
            <input type="text" id="s-gls-sname" value="${v(s.glsSenderName)}" />
          </div>
          <div class="field">
            <label>Persoană de contact</label>
            <input type="text" id="s-gls-scontact" value="${v(s.glsSenderContact)}" />
          </div>
        </div>
        <div class="field">
          <label>Adresă</label>
          <input type="text" id="s-gls-saddress" value="${v(s.glsSenderAddress)}" />
        </div>
        <div class="form-row">
          <div class="field">
            <label>Oraș</label>
            <input type="text" id="s-gls-scity" value="${v(s.glsSenderCity)}" />
          </div>
          <div class="field">
            <label>Cod poștal</label>
            <input type="text" id="s-gls-szip" value="${v(s.glsSenderZipcode)}" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>Telefon</label>
            <input type="text" id="s-gls-sphone" value="${v(s.glsSenderPhone)}" />
          </div>
          <div class="field">
            <label>Email</label>
            <input type="text" id="s-gls-semail" value="${v(s.glsSenderEmail)}" />
          </div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:20px;">
        <h2>Sameday</h2>
        <div class="form-row">
          <div class="field">
            <label>Utilizator</label>
            <input type="text" id="s-sd-user" value="${v(s.samedayUsername)}" />
          </div>
          <div class="field">
            <label>Parolă${s.samedayPasswordSet ? ' — setată ✓' : ''}</label>
            <input type="password" id="s-sd-pass" placeholder="${s.samedayPasswordSet ? '••••••••  (lasă gol ca să păstrezi)' : 'Introdu parola'}" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>ID punct de ridicare</label>
            <input type="text" id="s-sd-pickupid" value="${v(s.samedayPickupPointId)}" />
          </div>
          <div class="field">
            <label>ID persoană de contact (opțional)</label>
            <input type="text" id="s-sd-contactid" value="${v(s.samedayContactPersonId)}" />
          </div>
        </div>
        <div class="field">
          <label>Adresă punct de ridicare</label>
          <input type="text" id="s-sd-pickupaddr" value="${v(s.samedayPickupPointAddress)}" />
        </div>
        <div style="margin-bottom:12px;">
          <button type="button" class="btn btn-sm" id="samedayAutofillBtn">↻ Preia automat din contul Sameday</button>
          <span class="hint" style="display:block;margin-top:4px;">Completează utilizatorul, parola și (opțional) ID-ul punctului de ridicare mai sus, apoi apasă — restul câmpurilor de mai jos se completează automat.</span>
        </div>
        <div class="sub" style="margin:16px 0 8px;">Date expeditor (folosite ca destinatar real la ridicările de la client)</div>
        <div class="form-row">
          <div class="field">
            <label>Nume firmă</label>
            <input type="text" id="s-sd-sname" value="${v(s.samedaySenderName)}" />
          </div>
          <div class="field">
            <label>Telefon</label>
            <input type="text" id="s-sd-sphone" value="${v(s.samedaySenderPhone)}" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>Cod poștal</label>
            <input type="text" id="s-sd-szip" value="${v(s.samedaySenderPostalCode)}" />
          </div>
          <div class="field">
            <label>Adresă</label>
            <input type="text" id="s-sd-saddress" value="${v(s.samedaySenderAddress)}" />
          </div>
        </div>
      </div>

      <button class="btn btn-primary" type="submit">Salvează setările</button>
    </form>
  `));

  content.querySelector('#samedayAutofillBtn').addEventListener('click', async () => {
    const btn = content.querySelector('#samedayAutofillBtn');
    const payload = {
      samedayUsername: content.querySelector('#s-sd-user').value.trim(),
      samedayPassword: content.querySelector('#s-sd-pass').value,
      samedayPickupPointId: content.querySelector('#s-sd-pickupid').value.trim(),
    };
    if (!payload.samedayUsername || !payload.samedayPassword) {
      showToast('Completează întâi utilizatorul și parola Sameday.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Se preiau datele…';
    try {
      const data = await api('/api/company/settings/sameday-autofill', { method: 'POST', body: JSON.stringify(payload) });
      content.querySelector('#s-sd-pickupid').value = data.samedayPickupPointId || '';
      content.querySelector('#s-sd-pickupaddr').value = data.samedayPickupPointAddress || '';
      content.querySelector('#s-sd-sname').value = data.samedaySenderName || '';
      content.querySelector('#s-sd-sphone').value = data.samedaySenderPhone || '';
      content.querySelector('#s-sd-szip').value = data.samedaySenderPostalCode || '';
      content.querySelector('#s-sd-saddress').value = data.samedaySenderAddress || '';
      content.querySelector('#s-sd-contactid').value = data.samedayContactPersonId || '';
      showToast('Date preluate din Sameday — verifică-le și apasă „Salvează setările".');
    } catch (err) {
      showToast('Eroare: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Preia automat din contul Sameday';
    }
  });

  content.querySelector('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = (id) => content.querySelector(id).value.trim();
    const payload = {
      merchantProShopUrl: q('#s-mp-url'),
      merchantProApiKey: q('#s-mp-key'),
      merchantProApiSecret: q('#s-mp-secret'),
      gomagShopUrl: q('#s-gomag-url'),
      gomagApiKey: q('#s-gomag-key'),
      glsUsername: q('#s-gls-user'),
      glsPassword: q('#s-gls-pass'),
      glsClientNumber: q('#s-gls-client'),
      glsSenderName: q('#s-gls-sname'),
      glsSenderContact: q('#s-gls-scontact'),
      glsSenderAddress: q('#s-gls-saddress'),
      glsSenderCity: q('#s-gls-scity'),
      glsSenderZipcode: q('#s-gls-szip'),
      glsSenderPhone: q('#s-gls-sphone'),
      glsSenderEmail: q('#s-gls-semail'),
      samedayUsername: q('#s-sd-user'),
      samedayPassword: q('#s-sd-pass'),
      samedayPickupPointId: q('#s-sd-pickupid'),
      samedayContactPersonId: q('#s-sd-contactid'),
      samedayPickupPointAddress: q('#s-sd-pickupaddr'),
      samedaySenderName: q('#s-sd-sname'),
      samedaySenderPhone: q('#s-sd-sphone'),
      samedaySenderPostalCode: q('#s-sd-szip'),
      samedaySenderAddress: q('#s-sd-saddress'),
    };
    try {
      await api('/api/company/settings', { method: 'PATCH', body: JSON.stringify(payload) });
      // reimprospatam starea "configurat/neconfigurat" a curierilor, altfel
      // ar ramane invechita pana la urmatoarea logare
      const [glsStatus, samedayStatus] = await Promise.all([
        api('/api/gls/status').catch(() => ({ configured: false })),
        api('/api/sameday/status').catch(() => ({ configured: false })),
      ]);
      glsConfigured = glsStatus.configured;
      samedayConfigured = samedayStatus.configured;
      showToast('Setări salvate');
      renderSettings();
    } catch (err) {
      showToast('Eroare: ' + err.message);
    }
  });
}

// ---------------- router principal ----------------

function render() {
  // panoul de administrare al platformei -- complet separat de autentificarea
  // normala de agent/companie, verificat inaintea oricarei alte logici
  if ((window.location.hash || '').split('?')[0] === '#/platform-admin') {
    renderPlatformAdminGate();
    return;
  }

  if (!currentAgent) {
    const publicHash = window.location.hash || '#/acasa';
    const publicPath = publicHash.split('?')[0];
    if (publicPath === '#/login') { renderLogin(); return; }
    if (publicPath === '#/signup') { renderSignup(); return; }
    if (publicPath === '#/forgot-password') { renderForgotPassword(); return; }
    if (publicPath === '#/reset-password') {
      const queryPart = publicHash.split('?')[1] || '';
      const params = new URLSearchParams(queryPart);
      renderResetPassword(params.get('token') || '');
      return;
    }
    if (publicPath === '#/ce-este') { renderMarketingWhatIs(); return; }
    if (publicPath === '#/preturi') { renderMarketingPricing(); return; }
    if (publicPath === '#/despre') { renderMarketingAbout(); return; }
    if (publicPath === '#/contact') { renderMarketingContact(); return; }
    renderMarketingHome();
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
    renderServiceReturnList('#/service', 'service');
  } else if (path === '#/retur') {
    hideDrawer();
    renderServiceReturnList('#/retur', 'retur');
  } else if (path === '#/schimb') {
    hideDrawer();
    renderServiceReturnList('#/schimb', 'schimb');
  } else if (path === '#/orders') {
    hideDrawer();
    renderOrdersList();
  } else if (path === '#/new') {
    renderNewTicket();
  } else if (path === '#/admin') {
    hideDrawer();
    renderAdmin();
  } else if (path === '#/settings') {
    hideDrawer();
    renderSettings();
  } else if (path === '#/administrare-platforma') {
    hideDrawer();
    if (isPlatformAdmin) renderPlatformAdminPanel(); else navigate('#/dashboard');
  } else if (path === '#/administrare-platforma-clienti') {
    hideDrawer();
    if (isPlatformAdmin) renderPlatformClientsPanel(); else navigate('#/dashboard');
  } else if (path.startsWith('#/tickets/')) {
    renderTicketDetail(path.replace('#/tickets/', ''));
  } else if (path.startsWith('#/orders/')) {
    renderOrderDetail(path.replace('#/orders/', ''));
  } else {
    navigate('#/dashboard');
  }
}

boot();
