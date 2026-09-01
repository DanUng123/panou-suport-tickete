// Client pentru API-ul Resend (https://resend.com/docs/api-reference/emails/send-email)
// Foloseste fetch nativ din Node, fara dependente npm.
//
// Cheia API vine dintr-o variabila de mediu la nivel de platforma
// (RESEND_API_KEY), nu per-companie -- trimiterea de email-uri
// tranzactionale (resetare parola etc.) e o functie a platformei, nu a
// vreunei companii client.

const RESEND_BASE_URL = process.env.RESEND_BASE_URL_OVERRIDE || 'https://api.resend.com';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'no-reply@easy-ticket.ro';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

async function sendEmail({ to, subject, html }) {
  if (!isConfigured()) {
    throw new Error('Trimiterea de email-uri nu este configurată pe server (lipsește RESEND_API_KEY).');
  }
  const res = await fetch(`${RESEND_BASE_URL}/emails`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* fara body */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Eroare Resend ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

module.exports = { isConfigured, sendEmail };
