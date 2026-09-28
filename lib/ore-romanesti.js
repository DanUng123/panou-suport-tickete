// Ceasul romanesc, tradus in UTC.
//
// Multe servicii romanesti (GoMag, Cargus) trimit ore in forma
// "2026-09-28 21:40:00", fara fus orar. Ceasul din spatele lor e insa cel
// romanesc, iar serverul nostru merge pe UTC: citita naiv, o comanda de seara
// sare peste miezul noptii si ajunge pe ziua urmatoare. Aici e locul unic in
// care corectam asta, ca sa nu-l rescrie fiecare integrare pe cont propriu.

const FORMAT_CEAS_RO = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Bucharest', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Decalajul fusului romanesc fata de UTC la un moment dat (+2h iarna, +3h vara). */
function decalajRomanesc(moment) {
  const p = {};
  for (const parte of FORMAT_CEAS_RO.formatToParts(moment)) p[parte.type] = parte.value;
  const caUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return caUtc - moment.getTime();
}

const FARA_FUS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

/**
 * Transforma o data in UTC ISO. Daca sirul nu are fus orar, il citim ca ora
 * romaneasca; daca are (Z sau +03:00), il lasam asa cum e -- e deja lipsit de
 * ambiguitate. Un sir de neinteles se intoarce neatins, ca sa nu pierdem
 * informatia inlocuind-o cu o data inventata.
 */
function inUtcIso(valoare) {
  if (!valoare) return null;
  const text = String(valoare).trim();
  if (!FARA_FUS.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? text : d.toISOString();
  }
  const caUtc = new Date(text.replace(' ', 'T') + 'Z');
  if (Number.isNaN(caUtc.getTime())) return text;
  // a doua trecere acopera noptile in care se schimba ora
  let real = new Date(caUtc.getTime() - decalajRomanesc(caUtc));
  real = new Date(caUtc.getTime() - decalajRomanesc(real));
  return real.toISOString();
}

/** Acelasi lucru, dar intors ca moment (Date) -- pentru cine are nevoie de milisecunde. */
function inMoment(valoare) {
  const iso = inUtcIso(valoare);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { inUtcIso, inMoment, decalajRomanesc };
