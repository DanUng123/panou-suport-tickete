/* Formularul pe care îl completează clientul magazinului.
 *
 * Trăiește separat de app.js dinadins: pagina asta se deschide de pe telefonul
 * unui om nervos că produsul nu e bun, iar el n-are de ce să descarce panoul
 * operatorului ca să scrie un IBAN. Aici sunt doar formularul și ce ține de el.
 */

const TIPURI_CERERE_PUBLICE = [
  { cod: 'retur', titlu: 'Retur produs', descriere: 'Vreau să returnez produsul și să primesc banii înapoi.' },
  { cod: 'service', titlu: 'Garanție / Service', descriere: 'Produsul s-a defectat sau a venit deteriorat.' },
  { cod: 'schimb', titlu: 'Colet la schimb', descriere: 'Vreau același produs, înlocuit — a venit defect sau nu e mărimea potrivită.' },
];

// Regulile pe care le presupunem cat timp nu am primit inca raspunsul
// magazinului. Sunt cele mai permisive posibile: mai bine desenam un camp in
// plus, pe care serverul il ignora, decat sa ascundem unul de care clientul
// are nevoie.
const REGULI_CERERE_IMPLICITE = {
  types: ['retur', 'service', 'schimb'],
  reasons: [],
  refundToBank: true,
  partial: true,
  windowDays: 14,
};

/** Cum se numesc cele trei tipuri de cerere în panoul managerului. */
const ETICHETE_TIP_CERERE = {
  retur: 'Retur produs',
  service: 'Garanție / Service',
  schimb: 'Colet la schimb',
};

const ETICHETE_ANCORA = {
  delivered: 'de la livrare',
  shipped: 'de la expediere',
  created: 'de la plasarea comenzii',
};

function renderCerereClient(slug, { integrat = false, dateInitiale = null } = {}) {
  const ecran = el(`
    <div class="cerere-screen${integrat ? ' integrat' : ''}">
      <div class="cerere-card">
        <div class="auth-brand">
          <div class="name" id="cerereMagazin">Se încarcă…</div>
        </div>
        <div id="cererePas">Se încarcă…</div>
      </div>
      <div class="cerere-subsol" id="cerereSubsol"></div>
    </div>
  `);
  app.innerHTML = '';
  app.appendChild(ecran);
  currentMainRoute = null;
  if (integrat) {
    document.documentElement.classList.add('mod-integrat');
    // pornim pe deschis si corectam mai jos daca magazinul e pe fond inchis --
    // altfel, cat dureaza cererea catre server, s-ar vedea o clipa text
    // deschis pe alb
    ecran.classList.add('tema-deschisa');
  }

  // Cand formularul e integrat in magazin, pagina-gazda nu stie cat de inalt e
  // continutul, iar el se schimba de la un pas la altul. Ii spunem noi, la
  // fiecare randare, ca sa nu apara o bara de derulare in interiorul cadrului.
  let ultimaInaltime = 0;
  const anuntaInaltimea = () => {
    if (!integrat || window.parent === window) return;
    // masuram CARDUL, nu ecranul: ecranul e element flex si s-ar putea intinde
    // pe inaltimea cadrului, adica exact pe valoarea pe care tocmai am trimis-o
    const cutie = ecran.querySelector('.cerere-card') || ecran;
    const h = Math.ceil(cutie.getBoundingClientRect().height) + 8;
    // Anuntam DOAR cand chiar s-a schimbat ceva. Fara garda asta se face o
    // bucla: noi trimitem inaltimea, gazda redimensioneaza cadrul,
    // redimensionarea declanseaza la noi evenimentul de resize, si o luam de la
    // capat -- cadrul tremura la nesfarsit.
    if (Math.abs(h - ultimaInaltime) < 2) return;
    ultimaInaltime = h;
    try { window.parent.postMessage({ type: 'easyticket:inaltime', slug, height: h }, '*'); } catch (e) { /* gazda o ignora */ }
  };
  // ---- culorile magazinului, citite de scriptul de pe pagina lui ----
  // Din cadru nu putem vedea cum arata site-ul gazda (origini diferite), asa ca
  // ni le trimite el. Validam fiecare valoare: o culoare inseamna doar #rrggbb
  // sau rgb(...), iar fontul doar nume de familii -- nimic altceva nu ajunge
  // intr-un stil.
  let autoCulori = true;
  let temaPrimita = null;
  const eCuloare = (v) => /^#[0-9a-fA-F]{3,8}$/.test(String(v || '')) || /^rgba?\([\d.,\s/%]+\)$/.test(String(v || ''));
  const eFont = (v) => /^[\w\s,'"\-]{1,200}$/.test(String(v || ''));

  function aplicaTemaGazdei(tema) {
    if (!autoCulori || !tema) return;
    const pune = (nume, valoare, verifica) => { if (verifica(valoare)) ecran.style.setProperty(nume, valoare); };
    pune('--accent', tema.accent, eCuloare);
    pune('--accent-text', tema.accentText, eCuloare);
    pune('--text', tema.text, eCuloare);
    if (eFont(tema.font)) ecran.style.setProperty('font-family', tema.font);
    // fundalul gazdei ne spune daca site-ul e deschis sau inchis la culoare --
    // mai de incredere decat setarea din platforma, pentru ca e chiar pagina lui
    const f = String(tema.bg || '');
    if (/^#[0-9a-fA-F]{6}$/.test(f)) {
      const lum = (0.299 * parseInt(f.slice(1, 3), 16) + 0.587 * parseInt(f.slice(3, 5), 16) + 0.114 * parseInt(f.slice(5, 7), 16)) / 255;
      ecran.classList.toggle('tema-deschisa', lum > 0.5);
    }
    requestAnimationFrame(anuntaInaltimea);
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'easyticket:tema') return;
    temaPrimita = e.data.tema || null;
    aplicaTemaGazdei(temaPrimita);
  });

  // dupa fiecare schimbare de continut, plus la incarcarea imaginilor de produs
  const observator = new MutationObserver(() => requestAnimationFrame(anuntaInaltimea));
  observator.observe(ecran, { childList: true, subtree: true });
  window.addEventListener('load', anuntaInaltimea);
  window.addEventListener('resize', anuntaInaltimea);

  const zona = ecran.querySelector('#cererePas');
  let magazin = null;
  let comanda = null;
  let tip = null;
  let reguli = REGULI_CERERE_IMPLICITE;
  let fereastra = null;   // termenul de retur calculat pentru comanda gasita
  let dejaCerut = false;  // comanda are deja o cerere, iar magazinul nu accepta mai multe

  const eroare = (mesaj) => `<div class="error-msg">${escapeHtml(mesaj)}</div>`;

  /** Tipurile pe care clientul le poate alege ACUM: pornite de magazin si, la retur/schimb, cu termenul neexpirat. */
  const tipuriDisponibile = () => TIPURI_CERERE_PUBLICE.filter((t) => {
    if (!reguli.types.includes(t.cod)) return false;
    if (fereastra && fereastra.expired && t.cod !== 'service') return false;
    return true;
  });

  const bani = (suma) => `${Number(suma).toFixed(2)} ${escapeHtml(comanda && comanda.currency || 'RON')}`;

  // ---- pasul 1: ce comandă ----
  async function pasIdentificare(mesaj) {
    zona.innerHTML = `
      <h1>Ai o problemă cu o comandă?</h1>
      <p class="sub">Completează numărul comenzii și telefonul cu care ai comandat, ca să găsim comanda ta.</p>
      ${mesaj ? eroare(mesaj) : ''}
      <form id="formIdent">
        <div class="field">
          <label for="cNr">Număr comandă</label>
          <input type="text" id="cNr" inputmode="numeric" placeholder="ex. 62475169" required autofocus />
        </div>
        <div class="field">
          <label for="cTel">Telefon</label>
          <input type="tel" id="cTel" placeholder="07xx xxx xxx" required />
        </div>
        <button class="btn btn-primary btn-block" type="submit">Caută comanda</button>
      </form>
    `;
    zona.querySelector('#formIdent').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = zona.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Căutăm…';
      try {
        const rezultat = await api('/api/public/cerere/verificare', {
          method: 'POST',
          body: JSON.stringify({ slug, orderNumber: zona.querySelector('#cNr').value, phone: zona.querySelector('#cTel').value }),
        });
        comanda = rezultat.order;
        fereastra = rezultat.window || null;
        dejaCerut = Boolean(rezultat.alreadyRequested);
        pasTipSiProduse();
      } catch (err) {
        pasIdentificare(err.message);
      }
    });
  }

  // ---- pasul 2: ce fel de cerere și pentru care produse ----
  function pasTipSiProduse(mesaj) {
    const disponibile = tipuriDisponibile();
    // Cand magazinul nu accepta a doua cerere pe aceeasi comanda, ne oprim
    // aici: nu are rost sa-l lasam pe client sa completeze tot, ca sa afle la
    // final ca nu se putea.
    if (dejaCerut) {
      zona.innerHTML = `
        <h1>Comanda #${escapeHtml(String(comanda.number))}</h1>
        <p class="sub">Pentru această comandă există deja o cerere trimisă.</p>
        <div class="hint">${escapeHtml(magazin || 'Magazinul')} o are în lucru și îți va răspunde. Dacă între timp a apărut altceva, răspunde la mesajul primit de la ei.</div>
        <div class="form-actions" style="justify-content:flex-start;">
          <button type="button" class="btn" id="cerereInapoi">← Altă comandă</button>
        </div>`;
      zona.querySelector('#cerereInapoi').addEventListener('click', () => { comanda = null; tip = null; pasIdentificare(); });
      return;
    }
    if (!disponibile.length) {
      const expirat = fereastra && fereastra.expired;
      zona.innerHTML = `
        <h1>Comanda #${escapeHtml(String(comanda.number))}</h1>
        <p class="sub">${expirat
          ? `Termenul de ${fereastra.days} zile pentru retur a trecut${fereastra.deadline ? ` pe ${escapeHtml(fmtDate(fereastra.deadline))}` : ''}.`
          : 'Magazinul nu primește cereri prin acest formular momentan.'}</p>
        <div class="hint">Dacă e vorba de o defecțiune în garanție, scrie direct magazinului — garanția nu ține de termenul de retur.</div>
        <div class="form-actions" style="justify-content:flex-start;">
          <button type="button" class="btn" id="cerereInapoi">← Altă comandă</button>
        </div>`;
      zona.querySelector('#cerereInapoi').addEventListener('click', () => { comanda = null; tip = null; pasIdentificare(); });
      return;
    }
    if (tip && !disponibile.some((t) => t.cod === tip)) tip = null;

    // Cand magazinul nu accepta retururi partiale, nu-l punem pe client sa
    // bifeze tot manual ca sa afle apoi ca era obligatoriu: bifam noi si
    // spunem de ce nu se poate altfel.
    const totSauNimic = !reguli.partial && comanda.items.length > 1;

    zona.innerHTML = `
      <h1>Comanda #${escapeHtml(String(comanda.number))}</h1>
      <p class="sub">${escapeHtml(comanda.customerName)} · ${comanda.date ? escapeHtml(fmtDate(comanda.date)) : ''}</p>
      ${fereastra && !fereastra.unlimited && !fereastra.expired ? `
        <div class="cerere-termen">
          ${fereastra.daysLeft === 0
            ? 'Azi e ultima zi în care poți cere retur pentru această comandă.'
            : `Mai ai <strong>${fereastra.daysLeft} ${fereastra.daysLeft === 1 ? 'zi' : 'zile'}</strong> pentru retur${fereastra.anchorKind ? ` (${fereastra.days} de zile ${ETICHETE_ANCORA[fereastra.anchorKind] || ''})` : ''}.`}
        </div>` : ''}
      ${mesaj ? eroare(mesaj) : ''}
      <div class="cerere-eticheta">Ce s-a întâmplat?</div>
      <div class="cerere-tipuri">
        ${disponibile.map((t) => `
          <button type="button" class="cerere-tip ${tip === t.cod ? 'ales' : ''}" data-tip="${t.cod}">
            <span class="cerere-tip-titlu">${escapeHtml(t.titlu)}</span>
            <span class="cerere-tip-desc">${escapeHtml(t.descriere)}</span>
          </button>
        `).join('')}
      </div>
      <div class="cerere-eticheta">Ce produse sunt vizate?</div>
      ${totSauNimic ? '<div class="hint" style="margin:-4px 0 8px;">Magazinul primește doar comanda întreagă înapoi, nu produse separate.</div>' : ''}
      <div class="cerere-produse">
        ${comanda.items.length ? comanda.items.map((it) => `
          <label class="cerere-produs">
            <input type="checkbox" value="${it.index}" ${totSauNimic ? 'checked disabled' : ''} />
            ${it.imageUrl
              ? `<img src="${escapeHtml(it.imageUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cerere-produs-poza-goala',textContent:'—'}))" />`
              : '<div class="cerere-produs-poza-goala">—</div>'}
            <span class="cerere-produs-text">
              <span class="cerere-produs-nume">${escapeHtml(it.name)}</span>
              <span class="cerere-produs-sub">${it.sku ? escapeHtml(it.sku) + ' · ' : ''}bucăți: ${it.quantity}</span>
            </span>
          </label>
        `).join('') : '<div class="hint">Comanda nu are produse înregistrate.</div>'}
      </div>
      <div class="form-actions" style="justify-content:space-between;">
        <button type="button" class="btn" id="cerereInapoi">← Altă comandă</button>
        <button type="button" class="btn btn-primary" id="cerereContinua">Continuă</button>
      </div>
    `;
    zona.querySelectorAll('.cerere-tip').forEach((b) => b.addEventListener('click', () => {
      tip = b.dataset.tip;
      zona.querySelectorAll('.cerere-tip').forEach((x) => x.classList.toggle('ales', x.dataset.tip === tip));
    }));
    zona.querySelector('#cerereInapoi').addEventListener('click', () => { comanda = null; tip = null; pasIdentificare(); });
    zona.querySelector('#cerereContinua').addEventListener('click', () => {
      // casutele dezactivate nu apar la :checked, deci la tot-sau-nimic luam
      // pur si simplu toate produsele
      const alese = totSauNimic
        ? comanda.items.map((it) => it.index)
        : [...zona.querySelectorAll('.cerere-produse input:checked')].map((i) => Number(i.value));
      if (!tip) return pasTipSiProduse('Alege întâi ce fel de cerere ai.');
      if (!alese.length) return pasTipSiProduse('Bifează cel puțin un produs.');
      pasDetalii(alese);
    });
  }

  // ---- pasul 3: ce mai are nevoie fiecare tip de cerere ----
  //
  // Cele trei tipuri cer lucruri diferite, si numai pe ale lor:
  //   retur   -- motiv, fotografii, datele bancare
  //   service -- motiv, fotografii, descrierea defectiunii
  //   schimb  -- motiv, ce vrea in loc, fotografii
  //
  // Adresa de ridicare NU se mai cere clientului. O stim deja din comanda lui,
  // iar serverul o completeaza singur -- trei campuri in plus de completat, cu
  // ce scrisese oricum la comanda, sunt trei motive in plus sa abandoneze.
  function pasDetalii(alese, mesaj) {
    const eRetur = tip === 'retur';
    const eService = tip === 'service';
    const eSchimb = tip === 'schimb';
    const cereIban = eRetur && reguli.refundToBank;
    const motive = (reguli.reasons && reguli.reasons[tip]) || [];
    // Motivul ales hotaraste si regula de fotografie, si taxa de transport.
    // Pana nu alege unul, nu stim niciuna dintre ele -- si mai ales nu avem ce
    // taxa sa-i aratam.
    const motivulCurent = () => {
      const camp = zona.querySelector('#cMotiv');
      return (camp && motive.find((m) => m.text === camp.value)) || null;
    };
    const regulaFotoCurenta = () => (motivulCurent() || {}).photo || 'optional';

    const campMotivHtml = `
        <div class="field">
          <label for="cMotiv">Motivul cererii</label>
          ${motive.length ? `
            <select id="cMotiv" required>
              <option value="">Alege motivul…</option>
              ${motive.map((m) => `<option value="${escapeHtml(m.text)}">${escapeHtml(m.text)}</option>`).join('')}
            </select>`
            : '<input type="text" id="cMotiv" maxlength="200" placeholder="ex. Produsul nu pornește" />'}
        </div>`;

    const campPozeHtml = `
        <div class="field" id="campPoze">
          <label for="cPoze">Fotografii <span id="cPozeCerinta">(opțional, maximum 6)</span></label>
          <input type="file" id="cPoze" accept="image/*" multiple />
          <div class="hint" id="cPozeInfo" style="margin-top:6px;"></div>
        </div>`;

    const campDescriereHtml = `
        <div class="field">
          <label for="cDesc">Descrie problema</label>
          <textarea id="cDesc" rows="4" maxlength="4000" required placeholder="Ce nu merge, de când, în ce condiții se întâmplă…"></textarea>
        </div>`;

    const campSchimbHtml = `
        <div class="field">
          <label for="cVariantaDorita">Același model, dar produs nou</label>
          <input type="text" id="cVariantaDorita" maxlength="120" placeholder="ex. același model, un produs nou" />
          <div class="hint" style="margin-top:6px;">Scrie aici dacă vrei altă mărime sau altă culoare.</div>
        </div>`;

    const campBancaHtml = cereIban ? `
        <div class="cerere-eticheta">Unde îți trimitem banii</div>
        <div class="field">
          <label for="cTitular">Titularul contului</label>
          <input type="text" id="cTitular" maxlength="120" required placeholder="Numele de pe cont" />
        </div>
        <div class="field">
          <label for="cIban">IBAN</label>
          <input type="text" id="cIban" required placeholder="RO49 AAAA 1B31 0075 9384 0000" />
        </div>
        <div class="field">
          <label for="cBanca">Banca</label>
          <input type="text" id="cBanca" maxlength="120" required placeholder="ex. Banca Transilvania" />
        </div>`
      : (eRetur ? `
        <div class="hint" style="margin-bottom:14px;">Magazinul îți returnează banii pe aceeași cale pe care ai plătit — nu e nevoie de IBAN.</div>` : '');

    // taxa de transport sta intre campuri, dar ramane goala pana cand clientul
    // alege un motiv care chiar are taxa
    const cutiaTaxei = '<div id="cutieTaxa"></div>';

    const campuri = eService ? [campMotivHtml, campPozeHtml, campDescriereHtml, cutiaTaxei]
      : eSchimb ? [campMotivHtml, campSchimbHtml, campPozeHtml, cutiaTaxei]
      : [campMotivHtml, campPozeHtml, cutiaTaxei, campBancaHtml];

    zona.innerHTML = `
      <h1>Câteva detalii</h1>
      <p class="sub">Mai avem nevoie doar de câteva lucruri și trimitem cererea.</p>
      ${mesaj ? eroare(mesaj) : ''}
      <form id="formDetalii" autocomplete="off">
        <input type="text" id="cCapcana" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;" aria-hidden="true" />
        ${campuri.join('')}
        <div class="form-actions" style="justify-content:space-between;">
          <button type="button" class="btn" id="cerereInapoi2">← Înapoi</button>
          <button class="btn btn-primary" type="submit">Trimite cererea</button>
        </div>
      </form>
    `;

    let poze = [];
    const info = zona.querySelector('#cPozeInfo');
    const cerinta = zona.querySelector('#cPozeCerinta');
    const campPoze = zona.querySelector('#campPoze');

    // Regula de fotografie se schimba odata cu motivul: „m-am răzgândit" nu
    // are ce poza, „a ajuns deteriorat" nu are sens fara.
    function actualizeazaCerintaFoto() {
      const regula = regulaFotoCurenta();
      campPoze.style.display = regula === 'off' ? 'none' : '';
      if (cerinta) cerinta.textContent = regula === 'required' ? '(obligatoriu — cel puțin una)' : '(opțional, maximum 6)';
    }

    // Taxa de transport se arata DOAR dupa ce clientul a ales un motiv, si
    // doar daca motivul acela are taxa. Sunt motive pentru care magazinul nu
    // percepe nimic -- produsul a venit stricat, sau i s-a trimis altul -- iar
    // o taxa aratata din prima, inainte sa stim de ce returneaza, ar speria pe
    // cineva care oricum n-avea de platit nimic.
    const cutieTaxa = zona.querySelector('#cutieTaxa');
    function actualizeazaTaxa() {
      const ales = motivulCurent();
      const taxa = (tip !== 'service' && ales && ales.fee > 0) ? ales.fee : 0;
      if (!taxa) { cutieTaxa.innerHTML = ''; return; }
      cutieTaxa.innerHTML = `
        <div class="cerere-cost">
          ${eSchimb
            // La schimb nu exista rambursare din care sa se retina ceva:
            // clientul primeste produsul inlocuit, nu bani inapoi. Deci costul
            // e o informare, iar magazinul ii spune cum se achita.
            ? `Pentru motivul ales, transportul coletului la schimb costă <strong>${bani(taxa)}</strong>. ${escapeHtml(magazin || 'Magazinul')} îți spune cum se achită, odată cu confirmarea cererii.`
            : `Pentru motivul ales, transportul returului costă <strong>${bani(taxa)}</strong> și se reține din suma care ți se rambursează.`}
        </div>`;
    }

    const campMotiv = zona.querySelector('#cMotiv');
    if (campMotiv) campMotiv.addEventListener('change', () => { actualizeazaCerintaFoto(); actualizeazaTaxa(); });
    actualizeazaCerintaFoto();
    actualizeazaTaxa();

    zona.querySelector('#cPoze').addEventListener('change', async (e) => {
      const fisiere = [...e.target.files].slice(0, 6);
      poze = [];
      for (const f of fisiere) {
        if (f.size > 3 * 1024 * 1024) { info.textContent = `„${f.name}" e prea mare (peste 3 MB) și a fost sărită.`; continue; }
        const dataUrl = await new Promise((rez) => { const r = new FileReader(); r.onload = () => rez(r.result); r.readAsDataURL(f); });
        poze.push({ mimeType: f.type, dataBase64: String(dataUrl).split(',')[1] });
      }
      if (poze.length) info.textContent = `${poze.length} ${poze.length === 1 ? 'fotografie pregătită' : 'fotografii pregătite'}.`;
    });

    zona.querySelector('#cerereInapoi2').addEventListener('click', () => pasTipSiProduse());
    zona.querySelector('#formDetalii').addEventListener('submit', async (e) => {
      e.preventDefault();
      // verificam aici, nu doar pe server, ca sa nu piarda clientul tot ce a
      // scris pe drum
      if (regulaFotoCurenta() === 'required' && !poze.length) {
        return pasDetalii(alese, 'Pentru motivul ales avem nevoie de cel puțin o fotografie a produsului.');
      }
      const btn = zona.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Se trimite…';
      const q = (sel) => { const n = zona.querySelector(sel); return n ? n.value : ''; };
      try {
        const rezultat = await api('/api/public/cerere', {
          method: 'POST',
          body: JSON.stringify({
            slug, type: tip,
            orderNumber: comanda.number, phone: comanda.phone,
            itemIndexes: alese,
            reason: q('#cMotiv'),
            description: q('#cDesc'),
            wantedVariant: q('#cVariantaDorita'),
            iban: q('#cIban'), accountHolder: q('#cTitular'), bankName: q('#cBanca'),
            // adresa de ridicare nu se mai trimite de aici: o ia serverul din
            // comanda clientului, unde e deja scrisa de mana lui
            website: q('#cCapcana'),
            photos: poze,
          }),
        });
        pasGata(rezultat);
      } catch (err) {
        pasDetalii(alese, err.message);
      }
    });
  }

  function pasGata(rezultat) {
    zona.innerHTML = `
      <div class="cerere-gata">
        <div class="cerere-bifa">✓</div>
        <h1>${rezultat.autoApproved ? 'Cererea ta e acceptată' : 'Am primit cererea ta'}</h1>
        <p class="sub">${rezultat.autoApproved
          ? `${escapeHtml(magazin || 'Magazinul')} acceptă cererea și îți trimite pașii următori pentru trimiterea coletului.`
          : `${escapeHtml(magazin || 'Magazinul')} a fost anunțat și îți va răspunde în cel mai scurt timp.`}</p>
        ${rezultat.transportCost > 0 ? `<div class="cerere-cost">${rezultat.transportDeducted
          ? `Din suma rambursată se reține <strong>${escapeHtml(Number(rezultat.transportCost).toFixed(2))} ${escapeHtml(rezultat.currency || 'RON')}</strong>, costul transportului.`
          : `Transportul coletului la schimb costă <strong>${escapeHtml(Number(rezultat.transportCost).toFixed(2))} ${escapeHtml(rezultat.currency || 'RON')}</strong>.`}</div>` : ''}
        ${rezultat.reference ? `<div class="cerere-referinta">Număr cerere<strong>${escapeHtml(rezultat.reference)}</strong></div>` : ''}
        <p class="hint">Poți închide pagina. Dacă mai ai o problemă, deschide din nou linkul primit de la magazin.</p>
      </div>
    `;
  }

  function aplicaInfo(info) {
    magazin = info.companyName;
    if (info.rules) reguli = { ...REGULI_CERERE_IMPLICITE, ...info.rules };
    ecran.querySelector('#cerereMagazin').textContent = info.companyName;
    // tema si culoarea alese de magazin, ca formularul sa semene cu site-ul lui
    if (info.theme !== 'dark') ecran.classList.add('tema-deschisa');
    autoCulori = info.autoColors !== false;
    if (/^#[0-9a-fA-F]{6}$/.test(info.accent || '')) ecran.style.setProperty('--accent', info.accent);
    if (temaPrimita) aplicaTemaGazdei(temaPrimita);
    pasIdentificare();
  }

  // Datele magazinului: fie ni le-a scris serverul chiar in pagina (cazul
  // formularului integrat -- atunci desenam pe loc, fara nicio cerere de
  // retea), fie le cerem noi (pagina de sine statatoare si previzualizarea din
  // Setari, unde documentul e acelasi pentru toate magazinele).
  if (dateInitiale) {
    aplicaInfo(dateInitiale);
    anuntaInaltimea();
    return;
  }
  (async () => {
    try {
      aplicaInfo(await api(`/api/public/cerere/${encodeURIComponent(slug)}`));
    } catch (e) {
      ecran.querySelector('#cerereMagazin').textContent = '';
      zona.innerHTML = `<h1>Formular indisponibil</h1><p class="sub">Linkul nu mai este valid. Cere-i magazinului adresa corectă.</p>`;
    }
    anuntaInaltimea();
  })();
}

/* Pornirea, când pagina e formularul integrat în magazin.
 *
 * Serverul scrie slug-ul și datele magazinului direct în documentul pe care îl
 * trimite, deci formularul se desenează din prima, fără să mai întrebe nimic
 * peste rețea. Înainte, aici era încă un drum dus-întors până la server, doar
 * ca să afle numele magazinului -- iar clientul se uita la o pagină goală cât
 * dura.
 *
 * În panou fișierul ăsta e încărcat la fel, dar atributul lipsește, deci nu se
 * întâmplă nimic: acolo rutarea din app.js decide ce se afișează.
 */
(function pornesteFormularulIntegrat() {
  const slug = document.documentElement.dataset.slug;
  if (!slug) return;
  let dateInitiale = null;
  const cutie = document.getElementById('date-magazin');
  if (cutie) {
    try { dateInitiale = JSON.parse(cutie.textContent); } catch (e) { dateInitiale = null; }
  }
  renderCerereClient(slug, { integrat: true, dateInitiale });
})();
