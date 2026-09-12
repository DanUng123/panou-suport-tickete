// Backup al bazei de date, rulat INTR-UN PROCES SEPARAT.
//
// De ce separat: comanda care produce o copie garantat consistenta a bazei
// (VACUUM INTO) e sincrona, iar node:sqlite nu o poate rula altfel. Executata
// in procesul serverului, ea blocheaza bucla de evenimente pe toata durata --
// adica intreaga platforma, pentru toti clientii, nu doar pentru compania
// vizata. Masurat pe 300.000 de comenzi: 4,5 secunde pe o masina cu doua
// nuclee rapide, considerabil mai mult pe planul mic de pe Render (0,5 CPU si
// un disc mai lent).
//
// Procesul copil deschide aceeasi baza cu o a doua conexiune si scrie copia.
// Baza e in modul WAL, deci un cititor nu blocheaza scriitorii: serverul
// continua sa raspunda normal cat timp copia se face.

const { spawn } = require('child_process');
const fs = require('fs');
const db = require('./db');

// Codul rulat in copil. Nu incarcam lib/db.js acolo -- ar declansa migrari,
// crearea de indecsi si bucla de indexare, adica exact munca pe care vrem s-o
// evitam. Deschidem direct fisierul, doar ca sa citim din el.
const SCRIPT_COPIL = `
  const { DatabaseSync } = require('node:sqlite');
  const [fisier, destinatie] = process.argv.slice(1);
  const sursa = new DatabaseSync(fisier, { readOnly: true });
  sursa.exec("VACUUM INTO '" + destinatie.replace(/'/g, "''") + "'");
  sursa.close();
`;

/**
 * Creeaza un backup fara sa blocheze serverul. Intoarce o promisiune cu
 * { created, path, ms } sau { skipped, reason }. Nu arunca: un backup ratat
 * nu trebuie sa doboare serverul, doar sa fie raportat in log.
 */
function createBackupInBackground(retentionCount = 4) {
  return new Promise((resolve) => {
    let plan;
    try {
      plan = db.prepareBackup();
    } catch (e) {
      return resolve({ skipped: true, reason: e.message });
    }
    if (plan.skipped) return resolve(plan);

    const inceput = Date.now();
    const copil = spawn(process.execPath, ['-e', SCRIPT_COPIL, plan.dbFile, plan.tmpPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let eroare = '';
    copil.stderr.on('data', (d) => { eroare += String(d); });

    const curata = () => {
      try { if (fs.existsSync(plan.tmpPath)) fs.unlinkSync(plan.tmpPath); } catch (e) { /* ignoram */ }
    };

    copil.on('error', (e) => { curata(); resolve({ skipped: true, reason: e.message }); });

    copil.on('close', (cod) => {
      if (cod !== 0) {
        curata();
        return resolve({ skipped: true, reason: (eroare.trim().split('\n').pop() || `cod de ieșire ${cod}`) });
      }
      try {
        // redenumire atomica: niciun fisier "pe jumatate" nu poarta numele final
        fs.renameSync(plan.tmpPath, plan.finalPath);
        db.rotateBackups(retentionCount);
      } catch (e) {
        curata();
        return resolve({ skipped: true, reason: e.message });
      }
      resolve({ created: true, path: plan.finalPath, ms: Date.now() - inceput });
    });
  });
}

module.exports = { createBackupInBackground };
