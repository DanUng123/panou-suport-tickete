# Diagnostic de unica folosinta -- NU face parte din aplicatie.
#
# Doua intrebari:
#   1. Trimite MerchantPro o data de livrare pe comanda? (date_delivered /
#      date_shipped). De ea depinde de cand pornim numaratoarea zilelor de
#      retur -- de la livrare, ca la ei, sau doar de la data comenzii.
#   2. Merge citirea catalogului de produse cu cheia ta? De ea depinde
#      "schimbul cu alt produs", unde clientul trebuie sa aleaga produsul nou.
#
# Nu afiseaza date personale: pentru comenzi arata doar datele calendaristice
# si statusul, iar pentru produse doar numele campurilor si cate produse sunt.
#
# Rulare (din radacina proiectului):
#   powershell -ExecutionPolicy Bypass -File scripts\merchantpro-livrare.ps1 -Shop https://www.mastomat.ro

param(
  [Parameter(Mandatory = $true)][string]$Shop,
  [string]$Key,
  [string]$Secret
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Key)    { $Key = Read-Host 'Cheie API MerchantPro' }
if (-not $Secret) {
  $secure = Read-Host 'Secret API MerchantPro' -AsSecureString
  $Secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$base = $Shop.TrimEnd('/')
$token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${Key}:${Secret}"))
$headers = @{ Authorization = "Basic $token"; Accept = 'application/json' }

function Get-Json {
  param([string]$Path)
  try {
    $resp = Invoke-WebRequest -Uri "$base$Path" -Headers $headers -Method Get -UseBasicParsing -TimeoutSec 40
    return @{ ok = $true; status = [int]$resp.StatusCode; data = ($resp.Content | ConvertFrom-Json) }
  } catch {
    $st = 0; $body = $null
    if ($_.Exception.Response) {
      $st = [int]$_.Exception.Response.StatusCode
      try { $body = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    }
    return @{ ok = $false; status = $st; error = $body }
  }
}

Write-Host ''
Write-Host '=== 1. DATA DE LIVRARE PE COMANDA ===' -ForegroundColor Cyan

$r = Get-Json -Path '/api/v2/orders?shipping_status=delivered&limit=5&sort=date_created.desc'
if (-not $r.ok) {
  Write-Host "  Nu am putut citi comenzile livrate (status $($r.status))." -ForegroundColor Red
  if ($r.error) { Write-Host "  $($r.error)" -ForegroundColor DarkGray }
} else {
  $comenzi = $r.data.data
  if (-not $comenzi -or $comenzi.Count -eq 0) {
    Write-Host '  Nicio comanda cu status "livrata" in cont.' -ForegroundColor Yellow
  } else {
    # ce campuri de tip data exista pe prima comanda
    # Doar campuri de tip DATA, plus statusul. Filtrul de dinainte prindea si
    # shipping_name / shipping_address / shipping_phone, adica exact datele
    # personale ale clientilor, pe care scriptul nu are ce sa le afiseze.
    $campuriData = $comenzi[0].PSObject.Properties |
      Where-Object { $_.Name -match '(?i)^(date_|payment_date|.*_date$|shipping_status$|shipping_delivery_info$)' } |
      Select-Object -ExpandProperty Name
    Write-Host "  Campuri legate de date/livrare gasite pe comanda:" -ForegroundColor Green
    $campuriData | ForEach-Object { Write-Host "    $_" -ForegroundColor Green }
    Write-Host ''
    Write-Host '  Valorile lor, pe ultimele comenzi livrate:' -ForegroundColor Cyan
    foreach ($c in $comenzi) {
      Write-Host ("    comanda #{0}  status={1}" -f $c.id, $c.shipping_status)
      foreach ($n in $campuriData) {
        $v = $c.$n
        if ($null -eq $v -or "$v" -eq '') { $v = '(gol)' }
        if ($v -is [System.Management.Automation.PSCustomObject] -or $v -is [Array]) { $v = '(obiect/lista)' }
        Write-Host ("       {0,-26} {1}" -f $n, $v)
      }
    }
    Write-Host ''
    $cuLivrare = @($comenzi | Where-Object { $_.date_delivered -and "$($_.date_delivered)" -ne '' }).Count
    $cuExpediere = @($comenzi | Where-Object { $_.date_shipped -and "$($_.date_shipped)" -ne '' }).Count
    Write-Host ("  CONCLUZIE: din {0} comenzi livrate, {1} au data de livrare completata, {2} au data de expediere." -f $comenzi.Count, $cuLivrare, $cuExpediere) -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '=== 2. CATALOGUL DE PRODUSE ===' -ForegroundColor Cyan

$p = Get-Json -Path '/api/v2/products?limit=2&include=images,variants'
if (-not $p.ok) {
  Write-Host "  Catalogul NU e accesibil cu aceasta cheie (status $($p.status))." -ForegroundColor Red
  if ($p.error) {
    $msg = ($p.error -replace '\s+', ' ')
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) + '...' }
    Write-Host "  $msg" -ForegroundColor DarkGray
  }
  Write-Host '  (Daca da 401/403, cheia are nevoie de drept de citire pe Produse.)' -ForegroundColor DarkGray
} else {
  $total = $p.data.meta.count.total
  Write-Host "  Catalogul e accesibil. Produse in total: $total" -ForegroundColor Green
  $prod = $p.data.data[0]
  if ($prod) {
    Write-Host '  Campurile unui produs:' -ForegroundColor Green
    $prod.PSObject.Properties | ForEach-Object {
      $tip = if ($_.Value -is [Array]) { "lista ($($_.Value.Count))" } elseif ($_.Value -is [System.Management.Automation.PSCustomObject]) { 'obiect' } else { 'valoare' }
      Write-Host ("    {0,-26} {1}" -f $_.Name, $tip)
    }
    $areImagini = ($prod.PSObject.Properties.Name -contains 'images')
    $areVariante = ($prod.PSObject.Properties.Name -contains 'variants')
    Write-Host ("  Imagini: {0} | Variante (marimi/culori): {1}" -f $(if ($areImagini) { 'da' } else { 'nu' }), $(if ($areVariante) { 'da' } else { 'nu' })) -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Gata. Trimite-mi tot ce a aparut mai sus.' -ForegroundColor Cyan
Write-Host ''
