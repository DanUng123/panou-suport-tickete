# Diagnostic de unica folosinta -- NU face parte din aplicatie.
# Verifica daca datele cererii de retur (inclusiv IBAN-ul) sunt expuse in API,
# undeva in obiectul comenzii sau intr-o sub-resursa a ei.
#
# Rulare (din radacina proiectului), cu numarul unei comenzi care ARE cerere de retur:
#   powershell -ExecutionPolicy Bypass -File scripts\merchantpro-comanda.ps1 -Shop https://www.mastomat.ro -Order 61506269
#
# Afiseaza doar NUMELE campurilor, nu si valorile, ca sa nu apara date personale
# in terminal. Raspunsul complet se salveaza local, in scripts\comanda-<id>.json,
# ca sa te poti uita tu in el. Sterge fisierul dupa ce ne lamurim.

param(
  [Parameter(Mandatory = $true)][string]$Shop,
  [Parameter(Mandatory = $true)][string]$Order,
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
    $resp = Invoke-WebRequest -Uri "$base$Path" -Headers $headers -Method Get -UseBasicParsing -TimeoutSec 30
    return @{ status = [int]$resp.StatusCode; content = $resp.Content }
  } catch {
    $st = 0
    if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
    return @{ status = $st; content = $null }
  }
}

# toate numele de campuri din raspuns, la orice adancime
function Get-FieldNames {
  param($Node, [string]$Prefix = '', [System.Collections.ArrayList]$Acc)
  if ($null -eq $Node) { return }
  if ($Node -is [System.Management.Automation.PSCustomObject]) {
    foreach ($prop in $Node.PSObject.Properties) {
      $name = if ($Prefix) { "$Prefix.$($prop.Name)" } else { $prop.Name }
      [void]$Acc.Add($name)
      Get-FieldNames -Node $prop.Value -Prefix $name -Acc $Acc
    }
  } elseif ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
    $first = $null
    foreach ($item in $Node) { $first = $item; break }
    if ($first) { Get-FieldNames -Node $first -Prefix "$Prefix[]" -Acc $Acc }
  }
}

$variante = [ordered]@{
  "/api/v2/orders/$Order"                          = 'comanda simpla'
  "/api/v2/orders/$Order`?include=line_items"      = 'comanda + produse'
  "/api/v2/orders/$Order`?include=returns"         = 'comanda + retururi'
  "/api/v2/orders/$Order`?include=return_requests" = 'comanda + cereri retur'
  "/api/v2/orders/$Order/returns"                  = 'sub-resursa retururi'
  "/api/v2/orders/$Order/return_requests"          = 'sub-resursa cereri retur'
}

Write-Host ''
foreach ($p in $variante.Keys) {
  $r = Get-Json -Path $p
  $color = if ($r.status -eq 200) { 'Green' } elseif ($r.status -eq 404) { 'DarkGray' } else { 'Yellow' }
  Write-Host ("{0,-5} {1,-24} {2}" -f $r.status, $variante[$p], $p) -ForegroundColor $color

  if ($r.status -eq 200 -and $r.content) {
    $obj = $r.content | ConvertFrom-Json
    $acc = New-Object System.Collections.ArrayList
    Get-FieldNames -Node $obj -Acc $acc
    $interesante = $acc | Where-Object { $_ -match '(?i)retur|return|iban|bank|refund|rambur' } | Select-Object -Unique
    if ($interesante) {
      Write-Host '      campuri relevante gasite:' -ForegroundColor Green
      $interesante | ForEach-Object { Write-Host "        $_" -ForegroundColor Green }
    } else {
      Write-Host '      niciun camp legat de retur/IBAN' -ForegroundColor DarkGray
    }
  }
}

# salvam varianta cea mai bogata, local, pentru inspectie manuala
$full = Get-Json -Path "/api/v2/orders/$Order`?include=line_items"
if ($full.status -eq 200) {
  $out = Join-Path $PSScriptRoot "comanda-$Order.json"
  $full.content | Out-File -FilePath $out -Encoding utf8
  Write-Host ''
  Write-Host "Raspunsul complet a fost salvat in: $out" -ForegroundColor Cyan
  Write-Host 'Contine date personale -- sterge-l dupa ce te uiti in el.' -ForegroundColor DarkGray
}
Write-Host ''
