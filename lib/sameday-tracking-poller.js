// Job de fundal care preia periodic evenimentele recente de status de la
// Sameday (ultimele 2 ore, tot ce s-a schimbat pe cont) si le salveaza in
// propria baza de date -- Sameday NU ofera interogare per-AWB (confirmat
// direct de suportul lor tehnic), doar acest tip de fereastra de timp.
//
// Rulat la fiecare 90 de minute (nu la fiecare 2 ore exact) -- ferestrele
// succesive se suprapun intentionat cu 30 de minute, ca sa nu piarda
// niciun eveniment din cauza unei mici intarzieri de executie.

const db = require('./db');
const sameday = require('./sameday');

let intervalHandle = null;
let polling = false;

async function pollAllCompanies() {
  if (polling) return { skipped: true, reason: 'Preluare deja în curs.' };
  polling = true;
  try {
    const companies = db.listAllCompanies().filter((c) => sameday.isConfigured(c));
    const results = {};
    for (const company of companies) {
      try {
        const events = await sameday.pollRecentStatusChanges(company);
        results[company.id] = db.recordSamedayTrackingEvents(company.id, events);
      } catch (e) {
        results[company.id] = { error: e.message };
      }
    }
    return results;
  } finally {
    polling = false;
  }
}

function startBackgroundPolling(intervalMs) {
  if (intervalHandle) return;
  console.log(`Preluare istoric tracking Sameday din fundal activă, la fiecare ${Math.round(intervalMs / 60000)} min.`);
  pollAllCompanies().catch((e) => console.error('Eroare la preluarea inițială tracking Sameday:', e.message));
  intervalHandle = setInterval(() => {
    pollAllCompanies().catch((e) => console.error('Eroare la preluarea tracking Sameday:', e.message));
  }, intervalMs);
}

module.exports = { pollAllCompanies, startBackgroundPolling };
