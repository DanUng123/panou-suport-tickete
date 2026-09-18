/**
 * Scriptul de integrare a formularului de cereri în magazinul clientului.
 *
 * Magazinul pune o singură linie în pagina lui:
 *   <script src="https://easy-ticket.ro/formular.js" data-slug="magazinul-lui"></script>
 *
 * De ce un script și nu direct un <iframe>: scriptul rulează pe pagina
 * magazinului, deci poate CITI cum arată acel site — culoarea butoanelor,
 * fundalul, fontul — și le poate trimite formularului. Din interiorul unui
 * cadru nu se poate: browserul nu lasă o pagină să se uite la stilurile alteia,
 * de pe alt domeniu. Tot aici se face și potrivirea înălțimii.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) {
    var toate = document.getElementsByTagName('script');
    script = toate[toate.length - 1];
  }
  var slug = script.getAttribute('data-slug');
  if (!slug) return;

  var origine = new URL(script.src, location.href).origin;

  // ---------- cadrul ----------
  var cadru = document.createElement('iframe');
  cadru.src = origine + '/embed/' + encodeURIComponent(slug);
  cadru.title = 'Formular cereri';
  cadru.loading = 'lazy';
  cadru.setAttribute('style', 'display:block;width:100%;border:0;min-height:200px;overflow:hidden');
  var gazda = document.getElementById('easyticket-formular');
  if (gazda) gazda.appendChild(cadru);
  else script.parentNode.insertBefore(cadru, script);

  // ---------- citirea culorilor magazinului ----------

  function caRgb(valoare) {
    var m = String(valoare || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i);
    if (!m) return null;
    var a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a < 0.9) return null; // semitransparent: nu ne putem baza pe el
    return { r: +m[1], g: +m[2], b: +m[3] };
  }

  /** Variabilele CSS de temă sunt de obicei scrise în hex, nu în rgb(). */
  function caRgbDinHex(valoare) {
    var m = String(valoare || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }

  function hex(c) {
    var d = function (n) { return ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2); };
    return '#' + d(c.r) + d(c.g) + d(c.b);
  }

  /** Cât de „colorată" e o culoare: gri-urile și extremele nu sunt culori de brand. */
  function scorDeAccent(c) {
    if (!c) return -1;
    var max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
    var saturatie = max === 0 ? 0 : (max - min) / max;
    var luminozitate = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    if (saturatie < 0.25) return -1;                    // gri, alb, negru
    if (luminozitate > 0.92 || luminozitate < 0.06) return -1; // prea deschis / prea închis
    // preferăm ceva de mijloc, nici pastel spălăcit, nici aproape negru
    return saturatie * (1 - Math.abs(luminozitate - 0.45));
  }

  function citesteTema() {
    var tema = {};
    try {
      var corp = getComputedStyle(document.body);
      var fundal = caRgb(corp.backgroundColor);
      // fundalul poate fi transparent pe <body>; atunci îl luăm de pe <html>
      if (!fundal) fundal = caRgb(getComputedStyle(document.documentElement).backgroundColor);
      if (fundal) tema.bg = hex(fundal);
      var text = caRgb(corp.color);
      if (text) tema.text = hex(text);
      if (corp.fontFamily) tema.font = corp.fontFamily;

      // Accentul: culoarea „de brand" a magazinului.
      //
      // Prima încercare, cea mai exactă: multe teme își declară culoarea în
      // variabile CSS pe :root (--primary, --brand, --color-accent…).
      var radacina = getComputedStyle(document.documentElement);
      var numeVariabile = ['--primary', '--brand', '--accent', '--main-color', '--color-primary',
        '--color-brand', '--color-accent', '--theme-color', '--primary-color', '--brand-color'];
      var celMaiBun = null, celMaiBunScor = 0;
      for (var v = 0; v < numeVariabile.length; v++) {
        var val = radacina.getPropertyValue(numeVariabile[v]).trim();
        if (!val) continue;
        var cv = caRgb(val) || caRgbDinHex(val);
        var sv = scorDeAccent(cv);
        if (sv > celMaiBunScor) { celMaiBunScor = sv * 1.4; celMaiBun = cv; } // le dăm întâietate
      }

      // A doua: ne uităm la ce se vede efectiv în pagină. Nu doar la butoane și
      // linkuri -- un magazin poate avea bara de sus pe un simplu <div>, cu o
      // clasă în română, pe care niciun selector generic nu ar prinde-o.
      var toate = document.querySelectorAll('body *');
      for (var i = 0; i < toate.length && i < 600; i++) {
        var el = toate[i];
        var r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 10) continue;          // prea mic ca să fie parte din identitate
        if (r.top > 1400) continue;                            // prea jos ca să mai conteze
        var st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none') continue;

        var bonus = 1;
        // ce e sus, în antet, e aproape întotdeauna culoarea mărcii
        if (r.top < 260) bonus *= 1.25;
        // ce e de apăsat poartă culoarea de acțiune, exact ce ne trebuie pe buton
        try { if (el.matches('button, a, input[type=submit], [class*="btn"], [class*="button"]')) bonus *= 1.2; } catch (e2) {}

        var cf = caRgb(st.backgroundColor);
        var sf = scorDeAccent(cf) * bonus;
        if (sf > celMaiBunScor) { celMaiBunScor = sf; celMaiBun = cf; }

        var ct = caRgb(st.color);
        var stt = scorDeAccent(ct) * bonus * 0.75; // culoarea textului e un indiciu mai slab
        if (stt > celMaiBunScor) { celMaiBunScor = stt; celMaiBun = ct; }
      }
      if (celMaiBun) {
        tema.accent = hex(celMaiBun);
        // textul de pe buton: alb sau negru, după cât de închis e accentul --
        // altfel un accent galben ar rămâne cu scris alb, ilizibil
        var lum = (0.299 * celMaiBun.r + 0.587 * celMaiBun.g + 0.114 * celMaiBun.b) / 255;
        tema.accentText = lum > 0.62 ? '#111111' : '#ffffff';
      }
    } catch (e) { /* orice pagină neobișnuită: mergem pe culorile implicite */ }
    return tema;
  }

  function trimiteTema() {
    if (!cadru.contentWindow) return;
    try { cadru.contentWindow.postMessage({ type: 'easyticket:tema', tema: citesteTema() }, origine); } catch (e) { /* ignorăm */ }
  }

  cadru.addEventListener('load', trimiteTema);
  // fonturile web și temele încărcate târziu schimbă ce am citit: mai trimitem o dată
  setTimeout(trimiteTema, 1200);

  // ---------- înălțimea ----------
  var aRaspuns = false;
  window.addEventListener('message', function (e) {
    if (e.origin !== origine) return;
    if (!e.data || e.data.type !== 'easyticket:inaltime') return;
    aRaspuns = true;
    cadru.style.height = e.data.height + 'px';
    cadru.style.minHeight = '0';
  });

  // ---------- când cadrul nu răspunde ----------
  //
  // Formularul își anunță înălțimea imediat ce s-a desenat. Dacă nu vine nimic,
  // înseamnă că nu s-a desenat deloc, iar clientul se uită la o casetă goală.
  //
  // Cazul de departe cel mai frecvent: browserul a refuzat să pună formularul
  // în cadru, fiindcă domeniul magazinului nu e trecut în Setări. Refuzul ăsta
  // nu se poate citi din afara cadrului (e altă origine), deci îl deducem din
  // tăcere -- și spunem în consolă exact ce e de făcut. Clientul vede doar un
  // mesaj omenesc; instrucțiunea e pentru cel care a pus codul în pagină.
  setTimeout(function () {
    if (aRaspuns) return;
    console.error(
      '[Easy-Ticket] Formularul nu s-a putut încărca în pagină. Cauza obișnuită: domeniul ' +
      location.host + ' nu e trecut în Easy-Ticket → Setări → Formular de retur → ' +
      '„Domenii unde poate fi integrat". Adaugă-l acolo și reîncarcă pagina.'
    );
    var mesaj = document.createElement('div');
    mesaj.setAttribute('style',
      'padding:20px;border:1px solid #e2e5ea;border-radius:10px;background:#fff;' +
      'font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#4a5463;text-align:center');
    mesaj.textContent = 'Formularul nu a putut fi încărcat. Reîncarcă pagina, iar dacă nici așa nu merge, scrie-ne direct.';
    if (cadru.parentNode) cadru.parentNode.replaceChild(mesaj, cadru);
  }, 6000);
})();
