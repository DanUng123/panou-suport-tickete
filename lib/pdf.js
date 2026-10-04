'use strict';

/**
 * Generator PDF minimal, fara nicio dependenta npm — construit manual,
 * conform specificatiei PDF de baza (obiecte + xref + trailer).
 * Suporta doar text simplu, o singura pagina, font Helvetica standard.
 *
 * Limitare cunoscuta: fontul Helvetica standard (WinAnsiEncoding) nu
 * acopera diacriticele romanesti cu virgula (ș/ț) in mod fiabil pe toate
 * cititoarele de PDF -- textul este transliterat (ă→a, â→a, î→i, ș→s, ț→t)
 * pentru compatibilitate garantata, fara a necesita incorporarea unui font.
 */

function transliterateRo(str) {
  const map = {
    'ă': 'a', 'Ă': 'A', 'â': 'a', 'Â': 'A', 'î': 'i', 'Î': 'I',
    'ș': 's', 'Ș': 'S', 'ş': 's', 'Ş': 'S', 'ț': 't', 'Ț': 'T', 'ţ': 't', 'Ţ': 'T',
    '—': '-', '–': '-', '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '…': '...',
  };
  return String(str)
    .replace(/[ăĂâÂîÎșȘşŞțȚţŢ—–\u2018\u2019\u201C\u201D…]/g, (c) => map[c] || c)
    // plasa de siguranta: orice alt caracter in afara intervalului Latin-1 (0-255)
    // devine '?' -- Helvetica/WinAnsi nu poate reda altfel, mai bine vizibil gresit
    // decat corupt/invizibil in PDF
    .replace(/[^\x00-\xFF]/g, '?');
}

function pdfEscapeText(str) {
  return transliterateRo(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const LATIME_PAGINA = 595;
const INALTIME_PAGINA = 842;
const MARGINE_STANGA = 50;

/** Fluxul de desenare al unei singure pagini: titlu, subtitlu, linii. */
function continutPagina({ title, subtitle, lines }) {
  let y = INALTIME_PAGINA - 70;
  const parti = [];
  parti.push(`BT /F2 18 Tf ${MARGINE_STANGA} ${y} Td (${pdfEscapeText(title)}) Tj ET`);
  y -= 22;
  if (subtitle) {
    parti.push(`BT /F1 10 Tf ${MARGINE_STANGA} ${y} Td (${pdfEscapeText(subtitle)}) Tj ET`);
    y -= 20;
  }
  parti.push(`BT /F1 10 Tf ${MARGINE_STANGA} ${y} Td (${'_'.repeat(70)}) Tj ET`);
  y -= 26;
  for (const line of lines) {
    if (y < 60) break; // o pagina per etichetă; continutul e scurt si incape
    parti.push(`BT /F1 11 Tf ${MARGINE_STANGA} ${y} Td (${pdfEscapeText(line)}) Tj ET`);
    y -= 20;
  }
  return parti.join('\n');
}

/**
 * PDF cu una sau mai multe pagini — câte una pentru fiecare etichetă.
 *
 * Numerotarea obiectelor PDF nu e o formalitate: catalogul trimite la lista de
 * pagini, fiecare pagină la fluxul ei de conținut, iar tabela xref de la final
 * trebuie să dea poziția exactă, în octeți, a fiecărui obiect. De-aceea
 * construim întâi lista completă, apoi calculăm pozițiile.
 *
 * @param {{title: string, subtitle?: string, lines: string[]}[]} pagini
 * @returns {Buffer}
 */
function generateMultiPagePdf(pagini) {
  const listaPagini = pagini.length ? pagini : [{ title: 'Fără conținut', lines: [] }];
  // 1 catalog, 2 lista de pagini, 3 si 4 fonturile, apoi perechi (pagina, continut)
  const PRIMUL_OBIECT_PAGINA = 5;
  const idPagina = (i) => PRIMUL_OBIECT_PAGINA + i * 2;
  const idContinut = (i) => PRIMUL_OBIECT_PAGINA + i * 2 + 1;

  const obiecte = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${listaPagini.map((_, i) => `${idPagina(i)} 0 R`).join(' ')}] /Count ${listaPagini.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  listaPagini.forEach((pag, i) => {
    const flux = continutPagina(pag);
    obiecte.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /MediaBox [0 0 ${LATIME_PAGINA} ${INALTIME_PAGINA}] /Contents ${idContinut(i)} 0 R >>`);
    obiecte.push(`<< /Length ${Buffer.byteLength(flux, 'latin1')} >>\nstream\n${flux}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const pozitii = [];
  obiecte.forEach((obj, idx) => {
    pozitii.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const inceputXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${obiecte.length + 1}\n0000000000 65535 f \n`;
  pozitii.forEach((poz) => { pdf += `${String(poz).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${obiecte.length + 1} /Root 1 0 R >>\nstartxref\n${inceputXref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * @param {{title: string, subtitle?: string, lines: string[]}} opts
 * @returns {Buffer} continutul PDF, gata de servit sau salvat
 */
function generateSimplePdf({ title, subtitle, lines }) {
  return generateMultiPagePdf([{ title, subtitle, lines }]);
}

module.exports = { generateSimplePdf, generateMultiPagePdf, transliterateRo };
