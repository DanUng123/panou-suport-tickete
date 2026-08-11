# Panou Suport — Aplicație de Tickete pentru Agenți

Aplicație web internă pentru gestionarea tichetelor de suport clienți, folosită de agenții unei firme.

## Funcționalități

- **Autentificare agenți** (selectare din listă + parolă)
- **Creare, atribuire și status tichete** — deschis / în lucru / în așteptare / rezolvat / închis
- **Categorii și priorități** — filtrare avansată în lista de tichete (status, prioritate, categorie, agent asignat, căutare text)
- **Comentarii pe tichet** — inclusiv note interne (nevizibile clientului)
- **Dashboard cu statistici** — tichete pe status, tichete pe categorie, volum activ per agent, timp mediu de rezolvare, tichete rezolvate azi, tichete neasignate

## Stack tehnic

- **Backend**: Node.js (module native `http`, `fs`, `crypto` — **fără dependențe npm**, deci nu necesită `npm install`)
- **Persistență**: SQLite, prin modulul **nativ** `node:sqlite` (inclus în Node.js, fără pachete externe) — datele stau într-un singur fișier, `data/app.db`
- **Frontend**: HTML/CSS/JavaScript vanilla (SPA cu rutare pe hash), fără framework sau build step

Am ales această arhitectură minimală (zero dependențe) ca aplicația să poată porni instant, oriunde există Node.js instalat, fără pași suplimentari — inclusiv baza de date, care e integrată în Node, nu un serviciu separat de configurat.

## Pornire

Necesită **[Node.js 22.5 sau mai nou](https://nodejs.org)** (suportul `node:sqlite` a fost introdus atunci). Verifică versiunea instalată cu `node -v`.

```bash
node server.js
```

La prima pornire, aplicația creează automat `data/app.db` și îl populează cu datele demo din `data/seed.json` (3 agenți, 6 tichete). La pornirile ulterioare, baza de date existentă nu mai e suprascrisă.

Apoi deschide **http://localhost:3000** în browser.

Poți schimba portul cu variabila de mediu `PORT`:

```bash
PORT=8080 node server.js
```

## Persistența datelor la găzduire (Render, Railway etc.)

Fișierul `data/app.db` trebuie să stea pe **disc persistent**, nu pe discul efemer al containerului — altfel se pierde la fiecare redeploy sau restart.

- **Render**: adaugă un *Persistent Disk*, montat pe exemplu la `/data`, apoi pornește aplicația cu `DB_FILE=/data/app.db node server.js` (variabilă de mediu `DB_FILE`).
- **Railway**: adaugă un *Volume*, montat similar, cu aceeași variabilă `DB_FILE`.
- **VPS propriu**: fișierul stă pe disc normal, nimic special de configurat.

Variabila `DB_FILE` e opțională — dacă lipsește, aplicația folosește implicit `data/app.db` relativ la codul sursă.

## Autentificare demo

| Agent | Rol | Parolă |
|---|---|---|
| Ana Pop | agent | `parola123` |
| Mihai Ionescu | agent | `parola123` |
| Elena Radu | manager | `parola123` |

Aplicația vine cu 6 tichete demo pre-populate pentru a putea testa imediat filtrele și dashboard-ul.

## Structura proiectului

```
ticket-support-app/
├── server.js           # server HTTP + rute API
├── lib/db.js            # logica de date (SQLite, prin node:sqlite)
├── data/
│   ├── seed.json         # date demo folosite doar la prima pornire
│   └── app.db             # baza de date (creată automat, nu e în git)
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js            # aplicația front-end (SPA)
├── package.json          # specifică versiunea minimă de Node (22.5+)
└── README.md
```

## Limitări cunoscute (de adresat înainte de producție)

- **Autentificare simplificată**: parolele sunt stocate în clar în baza de date, fără hashing. Pentru producție: hash cu bcrypt/argon2, sau integrare SSO.
- **Sesiuni în memorie**: la restart de server, toți agenții sunt delogați. Pentru producție: store de sesiuni persistent (Redis) sau JWT.
- **SQLite e potrivit pentru o echipă mică/medie** (zeci de agenți, acces concurent moderat). Pentru volum foarte mare sau multiple instanțe de server în paralel, migrează la Postgres.
- **`node:sqlite` e marcat experimental** de Node.js (dar stabil pentru acest tip de utilizare) — necesită Node 22.5+; verifică pe platforma de hosting că poți seta această versiune (de obicei prin `package.json` → `engines`, deja inclus aici).
- **Fără rate-limiting / protecție CSRF** pe formulare — de adăugat înainte de expunere publică.

## Extinderi posibile

- Notificări email la tichete noi / atribuiri
- Atașamente la tichete și comentarii
- SLA-uri și alerte pentru tichete depășite
- Rapoarte exportabile (CSV/PDF)
- Roluri și permisiuni diferențiate (agent vs. manager)
