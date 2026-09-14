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

// ruta curenta afisata "sub" panoul lateral (lista din spate) -- folosita
// pentru a sti unde revenim la inchiderea panoului si pentru a evita
// re-randarea inutila a fundalului cand deja arata ce trebuie
let currentMainRoute = null;
