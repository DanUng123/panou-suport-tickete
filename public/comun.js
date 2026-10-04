/* Easy-Ticket — bucățile folosite și de panou, și de formularul clientului.
 *
 * Fișierul ăsta există ca să nu mai fie nevoie ca un client care completează un
 * formular de retur să descarce ÎNTREG panoul operatorului. Formularul public
 * are nevoie de șase lucruri de aici; restul de un sfert de megaoctet din
 * app.js nu-l privește deloc.
 */

const app = document.getElementById('app');

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

// ---------------------------------------------------------------- tema

/*
 * Tema interfeței: întunecată, luminoasă, sau după setarea sistemului.
 *
 * Alegerea se ține în browserul acestui calculator, nu în contul companiei:
 * doi operatori care împart un cont pot sta unul lângă fereastră și altul
 * într-o cameră întunecată, iar preferința unuia n-are de ce s-o schimbe pe a
 * celuilalt. De aceea stă în localStorage și nu pleacă spre server.
 *
 * Codul ăsta rulează din comun.js, adică ÎNAINTE de app.js și înainte de
 * primul desen al paginii. Dacă ar rula mai târziu, un utilizator cu tema
 * luminoasă ar vedea o clipă ecranul întunecat, la fiecare încărcare.
 *
 * CSS-ul nu știe de „ca în sistem": aici traducem preferința în una dintre
 * cele două teme reale și rămânem cu urechea la sistem, dacă el decide.
 */
const TEME_POSIBILE = ['intunecata', 'luminoasa', 'sistem'];
const CHEIE_TEMA = 'easyticket-tema';

function temaPreferata() {
  try {
    const salvata = localStorage.getItem(CHEIE_TEMA);
    return TEME_POSIBILE.includes(salvata) ? salvata : 'intunecata';
  } catch (e) {
    // fereastră privată, stocare blocată — tema implicită, fără să stricăm nimic
    return 'intunecata';
  }
}

function sistemulEDeschis() {
  try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return false; }
}

/** Pune pe <html> tema REALĂ, cea pe care o înțelege foaia de stil. */
function aplicaTema(preferinta) {
  // Formularul clientului nu se atinge — nici cel integrat în magazin, nici cel
  // deschis separat: acolo tema o dă magazinul (din setările lui de culoare),
  // nu preferința operatorului care întâmplător folosește același browser.
  if (document.documentElement.classList.contains('mod-integrat')) return;
  const cale = location.pathname + location.hash;
  if (cale.includes('/cerere/')) return;
  const pref = TEME_POSIBILE.includes(preferinta) ? preferinta : temaPreferata();
  const reala = pref === 'sistem' ? (sistemulEDeschis() ? 'luminoasa' : 'intunecata') : pref;
  document.documentElement.dataset.tema = reala;
}

function salveazaTema(preferinta) {
  if (!TEME_POSIBILE.includes(preferinta)) return;
  try { localStorage.setItem(CHEIE_TEMA, preferinta); } catch (e) { /* mergem mai departe fără să ținem minte */ }
  aplicaTema(preferinta);
}

aplicaTema(temaPreferata());

// dacă utilizatorul a ales „ca în sistem", urmărim schimbarea lui (de pildă
// trecerea automată la tema întunecată seara) fără să fie nevoie de reîncărcare
try {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (temaPreferata() === 'sistem') aplicaTema('sistem');
  });
} catch (e) { /* browser vechi — rămâne ce s-a aplicat la încărcare */ }

// ruta curenta afisata "sub" panoul lateral (lista din spate) -- folosita
// pentru a sti unde revenim la inchiderea panoului si pentru a evita
// re-randarea inutila a fundalului cand deja arata ce trebuie
let currentMainRoute = null;
