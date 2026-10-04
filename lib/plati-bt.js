// Fișierul de plăți în lot pentru BT Go (Banca Transilvania).
//
// Formatul e cel documentat de BT pentru importul „bulk": un CSV cu unsprezece
// coloane, în ordinea de mai jos. Regulile care contează, luate din
// instrucțiunile lor:
//
//   - suma are PUNCT ca separator zecimal;
//   - detaliile plății (PaymentRef1/2) se scriu fără diacritice și fără
//     caracterele  ~ ! @ # $ % ^ * / - ? : , ' + ;  — maximum 105 caractere;
//   - data plății e în formatul zz/ll/aaaa;
//   - Urgent = T doar pentru plăți de la 50.000 RON în sus, altfel F;
//   - BIC-ul băncii beneficiarului se scrie complet, cu „XXX" la final.
//
// Separatorul coloanelor e punct-și-virgulă: BT pornește de la un model Excel
// pe care îți cere să-l salvezi ca CSV, iar un Excel cu setări românești scrie
// exact așa. Dacă banca îți respinge fișierul, e singurul lucru de schimbat --
// de-aia stă într-o constantă, nu împrăștiat prin cod.

const banci = require('./banci-ro');

const SEPARATOR = ';';
const COLOANE = [
  'OrderNumber', 'SourceAccountNumber', 'TargetAccountNumber', 'BeneficiaryName',
  'BeneficiaryBankBIC', 'BeneficiaryFiscalCode', 'Amount', 'PaymentRef1',
  'PaymentRef2', 'ValueDate', 'Urgent',
];

// de la suma asta în sus, BT cere regim urgent
const PRAG_URGENT = 50000;

/** Fără diacritice și fără caracterele pe care BT nu le acceptă în detalii. */
function curataText(text, lungimeMaxima = 105) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // caracterele interzise de BT, plus ghilimelele si bara oblica inversa,
    // care ar rupe un CSV chiar daca banca nu le interzice explicit
    .replace(/[~!@#$%^*/\-?:,'+;"\\]/g, ' ')
    // orice a mai ramas din afara alfabetului latin de baza (liniute lungi,
    // ghilimele tipografice, emoji) -- ar putea strica parsarea fisierului
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, lungimeMaxima);
}

/** zz/ll/aaaa, cum cere BT. */
function dataBt(moment = new Date()) {
  const zz = String(moment.getDate()).padStart(2, '0');
  const ll = String(moment.getMonth() + 1).padStart(2, '0');
  return `${zz}/${ll}/${moment.getFullYear()}`;
}

/**
 * Construiește fișierul din tichetele date.
 *
 * Întoarce şi lista celor sărite, cu motivul — un tichet fără IBAN valid sau
 * cu o bancă necunoscută NU intră în fișier și NU se marchează ca plătit.
 * Mai bine nouă plăți corecte și una de lămurit, decât zece plăți din care una
 * pleacă greșit.
 */
function construiesteFisier({ tichete, ibanSursa, dataPlatii = new Date() }) {
  const randuri = [];
  const incluse = [];
  const sarite = [];
  let numarOrdin = 1;

  for (const t of tichete) {
    const cod = t.sectionCode || t.id;
    const iban = banci.normalizeazaIban(t.refundIban);
    const suma = Number(t.refundAmount);

    if (!iban) { sarite.push({ cod, motiv: 'nu are IBAN completat' }); continue; }
    if (!banci.ibanValid(iban)) { sarite.push({ cod, motiv: `IBAN-ul ${iban} nu trece verificarea de validitate` }); continue; }
    if (!Number.isFinite(suma) || suma <= 0) { sarite.push({ cod, motiv: 'nu are o sumă de returnat' }); continue; }
    const bic = banci.bicDinIban(iban);
    if (!bic) {
      sarite.push({ cod, motiv: `nu recunosc banca din IBAN (${banci.codBancaDinIban(iban) || '?'}) — completează plata manual` });
      continue;
    }

    randuri.push([
      numarOrdin,
      banci.normalizeazaIban(ibanSursa),
      iban,
      curataText(t.refundAccountHolder || t.requesterName, 70),
      bic,
      '', // cod fiscal — doar la plăți către Trezorerie
      suma.toFixed(2),
      // liniuța din „R-12" e un caracter interzis, iar un cod rupt în două
      // („R 12") se caută greu în extras — o scoatem de tot: „R12"
      curataText(`Rambursare retur ${String(cod).replace(/-/g, '')}`),
      curataText(t.refundReason || ''),
      dataBt(dataPlatii),
      suma >= PRAG_URGENT ? 'T' : 'F',
    ].join(SEPARATOR));
    incluse.push(t.id);
    numarOrdin += 1;
  }

  const csv = [COLOANE.join(SEPARATOR), ...randuri].join('\r\n');
  return { csv, incluse, sarite, total: randuri.length };
}

module.exports = { construiesteFisier, curataText, dataBt, COLOANE, SEPARATOR };
