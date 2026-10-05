<?php
/**
 * Easy-Ticket — conector pentru OpenCart
 * ---------------------------------------------------------------------------
 * De ce există fișierul ăsta: OpenCart nu are un API prin care să poți citi
 * comenzile. API-ul lui intern e făcut pentru coș și pentru plasarea unei
 * comenzi, nu pentru citirea lor, iar în OpenCart 4 nici ce funcționa în 3 nu
 * mai merge. Așa că citim direct din baza magazinului, cu un fișier pe care îl
 * pui tu în magazinul tău și care NU face decât să citească.
 *
 * INSTALARE
 *   1. Urcă fișierul în folderul principal al magazinului, lângă index.php.
 *   2. Verifică-l în browser: https://magazinul-tau.ro/easyticket.php
 *      Trebuie să scrie „Conector Easy-Ticket activ".
 *   3. Pune adresa de mai sus în Easy-Ticket, la Setări → Integrări → OpenCart.
 *
 * SECURITATE
 *   - Cheia de mai jos e generată de Easy-Ticket, unică pentru magazinul tău.
 *     Fără ea, fișierul nu răspunde cu nicio dată.
 *   - Conectorul face NUMAI citiri (SELECT). Nu scrie, nu șterge, nu modifică
 *     nimic în magazin.
 *   - Datele de conectare la baza de date sunt citite din config.php al
 *     magazinului. Nu le trimitem nicăieri și nu le afișăm niciodată.
 *   - Dacă bănuiești că ți s-a aflat cheia, generează alta din Easy-Ticket și
 *     înlocuiește fișierul. Vechea cheie devine inutilă pe loc.
 *
 * Versiune conector: 1.0 — OpenCart 2.x, 3.x și 4.x
 */

// Cheia magazinului. Easy-Ticket o completează automat la descărcare.
define('EASYTICKET_KEY', '__CHEIE__');

// Câte comenzi se întorc cel mult într-o cerere. Peste asta, Easy-Ticket cere
// pagina următoare. Limita e aici ca un magazin cu 200.000 de comenzi să nu
// încerce să le trimită pe toate deodată și să rămână fără memorie.
define('EASYTICKET_MAX_LIMIT', 200);

define('EASYTICKET_VERSIUNE', '1.0');

header('Content-Type: application/json; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: no-store');

function et_raspunde($date, $cod = 200) {
    http_response_code($cod);
    echo json_encode($date, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function et_eroare($mesaj, $cod = 400) {
    et_raspunde(array('ok' => false, 'error' => $mesaj), $cod);
}

// ---------------------------------------------------------------------------
// Cheia primită
// ---------------------------------------------------------------------------

function et_cheia_primita() {
    // Antetul e varianta normală; parametrul din adresă există pentru cazurile
    // în care găzduirea taie anteturile necunoscute (se întâmplă pe shared
    // hosting cu CGI).
    $antete = array('HTTP_X_EASYTICKET_KEY', 'HTTP_X_EASY_TICKET_KEY');
    foreach ($antete as $a) {
        if (!empty($_SERVER[$a])) return trim($_SERVER[$a]);
    }
    if (!empty($_GET['key'])) return trim($_GET['key']);
    return '';
}

$actiune = isset($_GET['action']) ? $_GET['action'] : '';

// Pagina deschisă în browser, fără cheie: spune doar că trăiește. Fără ea,
// omul care tocmai a urcat fișierul nu are cum să știe dacă a nimerit locul.
if ($actiune === '') {
    et_raspunde(array(
        'ok' => true,
        'service' => 'Conector Easy-Ticket activ',
        'connector_version' => EASYTICKET_VERSIUNE,
        'php' => PHP_VERSION,
        'hint' => 'Pune adresa asta în Easy-Ticket, la Setări → Integrări → OpenCart.',
    ));
}

// Verificăm lungimea, nu textul șablonului: altfel, o înlocuire automată care
// nimerește și linia asta ar lăsa conectorul să creadă că n-are cheie.
// Cheile emise de Easy-Ticket au 48 de caractere.
if (strlen(EASYTICKET_KEY) < 24) {
    et_eroare('Conectorul nu are o cheie validă. Descarcă-l din nou din Easy-Ticket — acolo se completează automat.', 500);
}

$cheie = et_cheia_primita();
if ($cheie === '' || !hash_equals(EASYTICKET_KEY, $cheie)) {
    // Mesaj identic pentru „lipsește" și „greșită": cine încearcă chei la
    // nimereală nu trebuie să afle care dintre ele a fost mai aproape.
    et_eroare('Cheie lipsă sau greșită.', 401);
}

// ---------------------------------------------------------------------------
// Baza de date, din config.php al magazinului
// ---------------------------------------------------------------------------

function et_incarca_config() {
    $cai = array(
        __DIR__ . '/config.php',          // fișierul stă în rădăcina magazinului
        dirname(__DIR__) . '/config.php', // sau într-un subfolder al ei
    );
    foreach ($cai as $cale) {
        if (is_readable($cale)) {
            // config.php al OpenCart doar definește constante; nu produce ieșire.
            require_once $cale;
            if (defined('DB_DATABASE')) return $cale;
        }
    }
    return null;
}

if (!et_incarca_config()) {
    et_eroare('Nu găsesc config.php. Pune easyticket.php în folderul principal al magazinului, lângă index.php.', 500);
}

$prefix = defined('DB_PREFIX') ? DB_PREFIX : 'oc_';
$port = defined('DB_PORT') && DB_PORT ? DB_PORT : '3306';

try {
    $dsn = 'mysql:host=' . DB_HOSTNAME . ';port=' . $port . ';dbname=' . DB_DATABASE . ';charset=utf8mb4';
    $pdo = new PDO($dsn, DB_USERNAME, DB_PASSWORD, array(
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ));
} catch (Exception $e) {
    // Mesajul brut al PDO conține uneori utilizatorul și gazda bazei. Nu îl
    // trimitem mai departe.
    et_eroare('Nu mă pot conecta la baza de date a magazinului.', 500);
}

// ---------------------------------------------------------------------------
// Diferențele dintre versiuni
// ---------------------------------------------------------------------------
// OpenCart 3 ține metoda de plată ca text simplu, plus o coloană separată cu
// codul ei. OpenCart 4 a scos coloanele de cod și ține totul într-un singur
// câmp, serializat. În loc să ghicim versiunea, ne uităm ce coloane există —
// merge și pe instalările modificate de cineva pe parcurs.

function et_coloane($pdo, $tabel) {
    try {
        $st = $pdo->query('SHOW COLUMNS FROM `' . $tabel . '`');
        $col = array();
        foreach ($st->fetchAll() as $r) $col[] = $r['Field'];
        return $col;
    } catch (Exception $e) {
        return array();
    }
}

$colOrder = et_coloane($pdo, $prefix . 'order');
if (!$colOrder) {
    et_eroare('Nu găsesc tabela de comenzi (' . $prefix . 'order). Prefixul din config.php nu pare să corespundă bazei.', 500);
}
$are = function ($nume) use ($colOrder) { return in_array($nume, $colOrder, true); };

/** Desface valoarea unei metode de plată/livrare, în orice formă ar fi salvată. */
function et_metoda($valoare) {
    if ($valoare === null || $valoare === '') return array('name' => null, 'code' => null);
    if (is_array($valoare)) {
        return array(
            'name' => isset($valoare['name']) ? $valoare['name'] : null,
            'code' => isset($valoare['code']) ? $valoare['code'] : null,
        );
    }
    $text = (string)$valoare;
    // OpenCart 4: JSON.
    $j = json_decode($text, true);
    if (is_array($j)) {
        return array(
            'name' => isset($j['name']) ? $j['name'] : null,
            'code' => isset($j['code']) ? $j['code'] : null,
        );
    }
    // Unele versiuni intermediare: serializat PHP.
    if (strlen($text) > 1 && ($text[0] === 'a' || $text[0] === 'O') && strpos($text, ':') === 1) {
        $s = @unserialize($text, array('allowed_classes' => false));
        if (is_array($s)) {
            return array(
                'name' => isset($s['name']) ? $s['name'] : null,
                'code' => isset($s['code']) ? $s['code'] : null,
            );
        }
    }
    // OpenCart 3 și mai vechi: chiar denumirea.
    return array('name' => $text, 'code' => null);
}

function et_adresa_magazin() {
    if (defined('HTTPS_SERVER') && HTTPS_SERVER) return rtrim(HTTPS_SERVER, '/');
    if (defined('HTTP_SERVER') && HTTP_SERVER) return rtrim(HTTP_SERVER, '/');
    return '';
}

// ---------------------------------------------------------------------------
// ping — pentru butonul „Testează conexiunea"
// ---------------------------------------------------------------------------

if ($actiune === 'ping') {
    $total = 0; $ultima = null;
    try {
        $r = $pdo->query('SELECT COUNT(*) AS n, MAX(date_added) AS ultima FROM `' . $prefix . 'order` WHERE order_status_id > 0')->fetch();
        $total = (int)$r['n'];
        $ultima = $r['ultima'];
    } catch (Exception $e) { /* numărătoarea nu e esențială */ }

    et_raspunde(array(
        'ok' => true,
        'connector_version' => EASYTICKET_VERSIUNE,
        'opencart' => defined('VERSION') ? VERSION : null,
        'php' => PHP_VERSION,
        'store_url' => et_adresa_magazin(),
        'db_prefix' => $prefix,
        'orders_total' => $total,
        'last_order_at' => $ultima,
        'schema' => $are('payment_code') ? 'opencart-3' : 'opencart-4',
    ));
}

// ---------------------------------------------------------------------------
// orders — lista de comenzi
// ---------------------------------------------------------------------------

if ($actiune !== 'orders') {
    et_eroare('Acțiune necunoscută: ' . $actiune, 404);
}

$limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 100;
if ($limit < 1) $limit = 1;
if ($limit > EASYTICKET_MAX_LIMIT) $limit = EASYTICKET_MAX_LIMIT;
$pagina = isset($_GET['page']) ? (int)$_GET['page'] : 1;
if ($pagina < 1) $pagina = 1;
$offset = ($pagina - 1) * $limit;

// „since" se compară cu data ULTIMEI MODIFICĂRI, nu cu cea a creării: altfel
// o comandă veche care tocmai a fost marcată „livrată" n-ar mai fi trimisă.
$since = isset($_GET['since']) ? trim($_GET['since']) : '';
$unde = array('o.order_status_id > 0');
$param = array();
if ($since !== '') {
    // Acceptăm atât „2026-10-05" cât și „2026-10-05 14:30:00" / ISO.
    $since = str_replace('T', ' ', $since);
    $since = preg_replace('/(\.\d+)?Z?$/', '', $since);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/', $since)) {
        et_eroare('Parametrul „since” nu are o formă de dată validă.');
    }
    $unde[] = '(o.date_modified >= ? OR o.date_added >= ?)';
    $param[] = $since;
    $param[] = $since;
}
// Un singur ID, pentru reîmprospătarea țintită a unei comenzi.
if (!empty($_GET['ids'])) {
    $ids = array_filter(array_map('intval', explode(',', $_GET['ids'])));
    if ($ids) {
        $unde[] = 'o.order_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')';
        foreach ($ids as $id) $param[] = $id;
    }
}
$clauza = implode(' AND ', $unde);

try {
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM `' . $prefix . 'order` o WHERE ' . $clauza);
    $st->execute($param);
    $total = (int)$st->fetch()['n'];

    // Ordinea e după data modificării, crescător: dacă sincronizarea se oprește
    // la jumătate, următoarea reia exact de unde a rămas.
    $sql = 'SELECT o.*, os.name AS status_name
            FROM `' . $prefix . 'order` o
            LEFT JOIN `' . $prefix . 'order_status` os
              ON os.order_status_id = o.order_status_id AND os.language_id = o.language_id
            WHERE ' . $clauza . '
            ORDER BY o.date_modified ASC, o.order_id ASC
            LIMIT ' . (int)$limit . ' OFFSET ' . (int)$offset;
    $st = $pdo->prepare($sql);
    $st->execute($param);
    $randuri = $st->fetchAll();
} catch (Exception $e) {
    et_eroare('Interogarea comenzilor a eșuat.', 500);
}

$ids = array();
foreach ($randuri as $r) $ids[] = (int)$r['order_id'];

// Produsele, pozele și istoricul se iau din câte O interogare pentru toată
// pagina, nu una pe comandă: la 100 de comenzi, diferența e între 3 interogări
// și 300, pe serverul clientului.
$produsePeComanda = array();
$istoricPeComanda = array();

if ($ids) {
    $semne = implode(',', array_fill(0, count($ids), '?'));
    $adresa = et_adresa_magazin();

    try {
        $sql = 'SELECT op.order_id, op.product_id, op.name, op.model, op.quantity, op.price, op.total, op.tax,
                       p.image AS product_image
                FROM `' . $prefix . 'order_product` op
                LEFT JOIN `' . $prefix . 'product` p ON p.product_id = op.product_id
                WHERE op.order_id IN (' . $semne . ')
                ORDER BY op.order_product_id ASC';
        $st = $pdo->prepare($sql);
        $st->execute($ids);
        foreach ($st->fetchAll() as $p) {
            $oid = (int)$p['order_id'];
            if (!isset($produsePeComanda[$oid])) $produsePeComanda[$oid] = array();
            $cant = (float)$p['quantity'];
            // „price" din OpenCart e fără TVA, iar „tax" e TVA-ul pe bucată.
            $unitar = (float)$p['price'] + (float)$p['tax'];
            $poza = null;
            if (!empty($p['product_image']) && $adresa !== '') {
                $poza = $adresa . '/image/' . ltrim($p['product_image'], '/');
            }
            $produsePeComanda[$oid][] = array(
                'product_id' => (int)$p['product_id'],
                'product_name' => $p['name'],
                'product_sku' => $p['model'],
                'product_image_url' => $poza,
                'quantity' => $cant,
                'unit_price_gross' => round($unitar, 4),
                'line_subtotal_gross' => round($unitar * $cant, 4),
            );
        }
    } catch (Exception $e) { /* fără produse, comanda tot e utilă */ }

    try {
        $sql = 'SELECT oh.order_id, oh.order_status_id, oh.comment, oh.date_added, os.name AS status_name
                FROM `' . $prefix . 'order_history` oh
                LEFT JOIN `' . $prefix . 'order_status` os ON os.order_status_id = oh.order_status_id
                WHERE oh.order_id IN (' . $semne . ')
                GROUP BY oh.order_history_id
                ORDER BY oh.date_added ASC';
        $st = $pdo->prepare($sql);
        $st->execute($ids);
        foreach ($st->fetchAll() as $h) {
            $oid = (int)$h['order_id'];
            if (!isset($istoricPeComanda[$oid])) $istoricPeComanda[$oid] = array();
            $istoricPeComanda[$oid][] = array(
                'status_id' => (int)$h['order_status_id'],
                'status' => $h['status_name'],
                'comment' => $h['comment'] !== '' ? $h['comment'] : null,
                'at' => $h['date_added'],
            );
        }
    } catch (Exception $e) { /* istoricul e util, dar nu obligatoriu */ }
}

// ---------------------------------------------------------------------------
// Forma în care trimitem comanda
// ---------------------------------------------------------------------------

function et_nume($prenume, $nume) {
    $t = trim(trim((string)$prenume) . ' ' . trim((string)$nume));
    return $t !== '' ? $t : null;
}

function et_gol($v) {
    if ($v === null) return null;
    $v = trim((string)$v);
    return $v === '' ? null : $v;
}

function et_adresa_completa($r, $prefixCamp) {
    $a1 = et_gol(isset($r[$prefixCamp . '_address_1']) ? $r[$prefixCamp . '_address_1'] : null);
    $a2 = et_gol(isset($r[$prefixCamp . '_address_2']) ? $r[$prefixCamp . '_address_2'] : null);
    if ($a1 === null && $a2 === null) return null;
    return trim($a1 . ($a2 !== null ? ', ' . $a2 : ''));
}

$comenzi = array();
foreach ($randuri as $r) {
    $oid = (int)$r['order_id'];
    $plata = et_metoda(isset($r['payment_method']) ? $r['payment_method'] : null);
    if (!$plata['code'] && !empty($r['payment_code'])) $plata['code'] = $r['payment_code'];
    $livrare = et_metoda(isset($r['shipping_method']) ? $r['shipping_method'] : null);

    $facturaNr = isset($r['invoice_no']) ? (int)$r['invoice_no'] : 0;

    $comenzi[] = array(
        'id' => $oid,
        'number' => $oid, // la OpenCart, numărul comenzii E identificatorul ei
        'store_id' => isset($r['store_id']) ? (int)$r['store_id'] : 0,
        'status_id' => (int)$r['order_status_id'],
        'status' => et_gol($r['status_name']),
        'currency' => et_gol($r['currency_code']),
        'currency_value' => isset($r['currency_value']) ? (float)$r['currency_value'] : 1,
        'total' => isset($r['total']) ? round((float)$r['total'], 4) : null,
        'comment' => et_gol($r['comment']),
        'tracking' => et_gol(isset($r['tracking']) ? $r['tracking'] : null),
        'date_added' => $r['date_added'],
        'date_modified' => $r['date_modified'],

        'customer' => array(
            'name' => et_nume($r['firstname'], $r['lastname']),
            'email' => et_gol($r['email']),
            'phone' => et_gol($r['telephone']),
        ),
        'payment' => array(
            'name' => $plata['name'],
            'code' => $plata['code'],
            'firstname' => et_gol($r['payment_firstname']),
            'lastname' => et_gol($r['payment_lastname']),
            'company' => et_gol($r['payment_company']),
            'address' => et_adresa_completa($r, 'payment'),
            'city' => et_gol($r['payment_city']),
            'zipcode' => et_gol($r['payment_postcode']),
            'region' => et_gol($r['payment_zone']),
            'country' => et_gol($r['payment_country']),
        ),
        'shipping' => array(
            'name' => et_nume($r['shipping_firstname'], $r['shipping_lastname']),
            'firstname' => et_gol($r['shipping_firstname']),
            'lastname' => et_gol($r['shipping_lastname']),
            'company' => et_gol($r['shipping_company']),
            'address' => et_adresa_completa($r, 'shipping'),
            'city' => et_gol($r['shipping_city']),
            'zipcode' => et_gol($r['shipping_postcode']),
            'region' => et_gol($r['shipping_zone']),
            'country' => et_gol($r['shipping_country']),
            // Telefonul și emailul stau pe comandă, nu pe adresă — le punem și
            // aici, ca Easy-Ticket să le găsească unde le caută la celelalte
            // platforme (fără ele nu se poate emite AWB de ridicare).
            'phone' => et_gol($r['telephone']),
            'email' => et_gol($r['email']),
            'method' => $livrare['name'],
        ),
        'invoice' => $facturaNr > 0
            ? array('prefix' => et_gol(isset($r['invoice_prefix']) ? $r['invoice_prefix'] : null), 'number' => (string)$facturaNr)
            : null,
        'line_items' => isset($produsePeComanda[$oid]) ? $produsePeComanda[$oid] : array(),
        'history' => isset($istoricPeComanda[$oid]) ? $istoricPeComanda[$oid] : array(),
    );
}

et_raspunde(array(
    'ok' => true,
    'connector_version' => EASYTICKET_VERSIUNE,
    'page' => $pagina,
    'limit' => $limit,
    'total' => $total,
    'pages' => $limit > 0 ? (int)ceil($total / $limit) : 1,
    'orders' => $comenzi,
));
