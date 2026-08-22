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

/**
 * @param {{title: string, subtitle?: string, lines: string[]}} opts
 * @returns {Buffer} continutul PDF, gata de servit sau salvat
 */
function generateSimplePdf({ title, subtitle, lines }) {
  const pageWidth = 595;
  const pageHeight = 842;
  const marginLeft = 50;
  let y = pageHeight - 70;

  const contentParts = [];
  contentParts.push(`BT /F2 18 Tf ${marginLeft} ${y} Td (${pdfEscapeText(title)}) Tj ET`);
  y -= 22;
  if (subtitle) {
    contentParts.push(`BT /F1 10 Tf ${marginLeft} ${y} Td (${pdfEscapeText(subtitle)}) Tj ET`);
    y -= 20;
  }
  contentParts.push(`BT /F1 10 Tf ${marginLeft} ${y} Td (${'_'.repeat(70)}) Tj ET`);
  y -= 26;

  for (const line of lines) {
    if (y < 60) break; // nu gestionam multi-pagina -- continut scurt, garantat sa incapa
    contentParts.push(`BT /F1 11 Tf ${marginLeft} ${y} Td (${pdfEscapeText(line)}) Tj ET`);
    y -= 20;
  }

  const contentStream = contentParts.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, idx) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { generateSimplePdf, transliterateRo };
