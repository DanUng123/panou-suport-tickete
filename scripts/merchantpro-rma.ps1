# Diagnostic de unica folosinta -- NU face parte din aplicatie.
# Verifica resursa de cereri de retur (RMA) descoperita in obiectul comenzii,
# unde ar trebui sa stea motivul, produsele si IBAN-ul clientului.
#
# Rulare (din radacina proiectului):
#   powershell -ExecutionPolicy Bypass -File scripts\merchantpro-rma.ps1 -Shop https://www.mastomat.ro -Rma 2
#
# Afiseaza doar NUMELE campurilor, nu si valorile. Raspunsurile se salveaza
# local, in scripts\rma-*.json, ca sa te poti uita tu in ele. Sterge-le dupa.

param(
  [Parameter(Mandatory = $true)][string]$Shop,
  [string]$Rma,
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
    $st = 0; $body = $null
    if ($_.Exception.Response) {
      $st = [int]$_.Exception.Response.StatusCode
      try { $body = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    }
    return @{ status = $st; content = $body }
  }
}

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

$paths = [ordered]@{
  '/api/v2/rma_requests'          = 'lista cereri RMA'
  '/api/v2/rma_requests?limit=5'  = 'lista cereri RMA (limit 5)'
  '/api/v2/rma-requests'          = 'varianta cu cratima'
  '/api/v2/rmarequests'           = 'varianta lipita'
}
if ($Rma) {
  $paths["/api/v2/rma_requests/$Rma"] = "cerere RMA #$Rma"
}

Write-Host ''
foreach ($p in $paths.Keys) {
  $r = Get-Json -Path $p
  $color = if ($r.status -eq 200) { 'Green' } elseif ($r.status -eq 404) { 'DarkGray' } else { 'Yellow' }
  Write-Host ("{0,-5} {1,-28} {2}" -f $r.status, $paths[$p], $p) -ForegroundColor $color

  if ($r.status -eq 200 -and $r.content) {
    $obj = $r.content | ConvertFrom-Json
    $acc = New-Object System.Collections.ArrayList
    Get-FieldNames -Node $obj -Acc $acc
    $names = $acc | Select-Object -Unique
    Write-Host '      campuri:' -ForegroundColor Green
    $names | ForEach-Object { Write-Host "        $_" -ForegroundColor Green }

    $safe = ($p -replace '[^a-zA-Z0-9]', '_')
    $out = Join-Path $PSScriptRoot "rma$safe.json"
    $r.content | Out-File -FilePath $out -Encoding utf8
    Write-Host "      salvat in: $out" -ForegroundColor Cyan
  } elseif ($r.content) {
    $msg = ($r.content -replace '\s+', ' ')
    if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) + '...' }
    Write-Host "      $msg" -ForegroundColor DarkGray
  }
}
Write-Host ''
Write-Host 'Fisierele salvate contin date personale -- sterge-le dupa ce ne lamurim.' -ForegroundColor DarkGray
Write-Host ''
