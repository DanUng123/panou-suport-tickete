# Diagnostic de unica folosinta -- NU face parte din aplicatie.
# Incearca sa extinda campul rma_requests de pe comanda, cu numele lui exact,
# plus cateva variante de versiune de API. Acolo ar trebui sa fie IBAN-ul,
# motivul si produsele cerute la retur.
#
# Rulare (din radacina proiectului):
#   powershell -ExecutionPolicy Bypass -File scripts\merchantpro-rma2.ps1 -Shop https://www.mastomat.ro -Order 28538296 -Rma 3

param(
  [Parameter(Mandatory = $true)][string]$Shop,
  [Parameter(Mandatory = $true)][string]$Order,
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
  "/api/v2/orders/$Order`?include=rma_requests"             = 'include=rma_requests'
  "/api/v2/orders/$Order`?include=line_items,rma_requests"  = 'include produse + rma'
  "/api/v2/orders/$Order`?include=rma"                      = 'include=rma'
  "/api/v2/orders/$Order/rma_requests"                      = 'sub-resursa rma_requests'
  "/api/v2/orders/$Order/rma"                               = 'sub-resursa rma'
  '/api/v1/rma_requests'                                    = 'v1: lista rma_requests'
  '/api/v1/returns'                                         = 'v1: returns'
  "/api/v1/orders/$Order"                                   = 'v1: comanda'
}
if ($Rma) {
  $paths["/api/v2/rma_requests/$Rma"] = "v2: cerere RMA #$Rma"
  $paths["/api/v1/rma_requests/$Rma"] = "v1: cerere RMA #$Rma"
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
    $rel = $acc | Where-Object { $_ -match '(?i)rma|iban|bank|retur|return|reason|motiv' } | Select-Object -Unique
    if ($rel) {
      Write-Host '      campuri relevante:' -ForegroundColor Green
      $rel | ForEach-Object { Write-Host "        $_" -ForegroundColor Green }
      $safe = ($p -replace '[^a-zA-Z0-9]', '_')
      $out = Join-Path $PSScriptRoot "rma2$safe.json"
      $r.content | Out-File -FilePath $out -Encoding utf8
      Write-Host "      salvat in: $out" -ForegroundColor Cyan
    } else {
      Write-Host '      nimic relevant' -ForegroundColor DarkGray
    }
  } elseif ($r.content) {
    $msg = ($r.content -replace '\s+', ' ')
    if ($msg.Length -gt 220) { $msg = $msg.Substring(0, 220) + '...' }
    Write-Host "      $msg" -ForegroundColor DarkGray
  }
}
Write-Host ''
