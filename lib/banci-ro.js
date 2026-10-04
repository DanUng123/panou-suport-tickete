// Băncile din România: din IBAN aflăm banca, iar din bancă aflăm codul BIC.
//
// Fișierul de plăți al BT cere codul BIC al băncii beneficiarului, inclusiv
// sufixul „XXX". Noi nu-l cerem clientului — ar fi absurd să-i cerem unui om
// care returnează o bormașină să-și caute codul SWIFT — așa că îl deducem din
// IBAN.
//
// Într-un IBAN românesc, după „RO" și cele două cifre de control urmează patru
// litere care identifică banca: RO49 **BTRL** 1234 5678 9012 3456. Tabelul de
// mai jos leagă acele patru litere de codul BIC complet.
//
// Ce NU facem: să inventăm un cod pentru o bancă pe care n-o cunoaștem. Un BIC
// greșit înseamnă o plată respinsă sau, mai rău, întârziată fără explicație. O
// bancă nerecunoscută se raportează explicit, iar tichetul rămâne pe loc.

const BIC_DUPA_COD_IBAN = {
  BTRL: 'BTRLRO22XXX', // Banca Transilvania
  RNCB: 'RNCBROBUXXX', // BCR
  BRDE: 'BRDEROBUXXX', // BRD — Groupe Société Générale
  BACX: 'BACXROBUXXX', // UniCredit Bank
  INGB: 'INGBROBUXXX', // ING Bank
  RZBR: 'RZBRROBUXXX', // Raiffeisen Bank
  CECE: 'CECEROBUXXX', // CEC Bank
  OTPV: 'OTPVROBUXXX', // OTP Bank
  PIRB: 'PIRBROBUXXX', // First Bank
  ROIN: 'ROINROBUXXX', // Salt Bank
  UGBI: 'UGBIROBUXXX', // Garanti BBVA
  REVO: 'REVOROBBXXX', // Revolut Bank, sucursala România
  BREL: 'BRELROBUXXX', // Libra Internet Bank
  TBIB: 'TBIBROBUXXX', // TBI Bank
  CARP: 'CARPRO22XXX', // Patria Bank
  EXIM: 'EXIMROBUXXX', // EximBank
  WBAN: 'WBANRO22XXX', // Intesa Sanpaolo Bank
  MIRO: 'MIROROBUXXX', // ProCredit Bank
  FNNB: 'FNNBROBUXXX', // Nexent Bank (fostă Credit Europe Bank)
  MIND: 'MINDROBUXXX', // BRCI
};

/** IBAN-ul, fără spații și cu litere mari — forma în care îl comparăm și îl trimitem. */
function normalizeazaIban(iban) {
  return String(iban || '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Verifică IBAN-ul după regula internațională (mod 97): mutăm primele patru
 * caractere la coadă, înlocuim literele cu numere și împărțim la 97 — restul
 * trebuie să fie 1. Prinde o cifră greșită sau două cifre inversate, adică
 * exact greșelile pe care le face un om care transcrie un IBAN dintr-un email.
 */
function ibanValid(iban) {
  const cod = normalizeazaIban(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(cod)) return false;
  const rearanjat = cod.slice(4) + cod.slice(0, 4);
  const cifre = rearanjat.replace(/[A-Z]/g, (l) => String(l.charCodeAt(0) - 55));
  // numărul e prea mare pentru un întreg obișnuit, așa că împărțim pe bucăți
  let rest = 0;
  for (const c of cifre) rest = (rest * 10 + Number(c)) % 97;
  return rest === 1;
}

/** Codul de patru litere al băncii, din IBAN-ul românesc. */
function codBancaDinIban(iban) {
  const cod = normalizeazaIban(iban);
  if (!/^RO[0-9]{2}[A-Z]{4}/.test(cod)) return null;
  return cod.slice(4, 8);
}

/**
 * Codul BIC al băncii beneficiarului, dedus din IBAN.
 * Întoarce null dacă banca nu e în tabel — niciodată o valoare ghicită.
 */
function bicDinIban(iban) {
  const codBanca = codBancaDinIban(iban);
  return (codBanca && BIC_DUPA_COD_IBAN[codBanca]) || null;
}

module.exports = { normalizeazaIban, ibanValid, codBancaDinIban, bicDinIban, BIC_DUPA_COD_IBAN };
