# Diagnostic de unica folosinta -- NU face parte din aplicatie.
# Intreaba API-ul MerchantPro al magazinului tau ce resurse exista, ca sa vedem
# daca cererile de retur (RMA) pot fi preluate automat si daca exista webhook-uri.
# Ruleaza direct in PowerShell, fara Node.js.
#
# Rulare (din radacina proiectului):
#   powershell -ExecutionPolicy Bypass -File scripts\merchantpro-resurse.ps1 -Shop https://www.elefant.ro
# Iti cere apoi cheia si secretul API (nu raman scrise in istoricul terminalului).
#
# Sau, daca preferi sa le dai direct:
#   powershell -ExecutionPolicy Bypass -File scripts\merchantpro-resurse.ps1 -Shop https://... -Key CHEIE -Secret SECRET

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

# cale -> ce verificam
$paths = [ordered]@{
  '/api/v2/orders?limit=1'   = 'control: comenzi (trebuie sa mearga)'
  '/api/v2'                  = 'index resurse (daca il expun)'
  '/api/v2/returns'          = 'cereri de retur'
  '/api/v2/return_requests'  = 'cereri de retur (alta denumire)'
  '/api/v2/order_returns'    = 'cereri de retur (alta denumire)'
  '/api/v2/rma'              = 'RMA'
  '/api/v2/rmas'             = 'RMA (plural)'
  '/api/v2/refunds'          = 'rambursari'
  '/api/v2/order_return_requests' = 'cereri de retur (varianta lunga)'
  '/api/v2/orders/returns'   = 'retururi sub comenzi'
  '/api/v2/contact_requests' = 'mesaje contact (exista ca eveniment)'
  '/api/v2/webhooks'         = 'WEBHOOK-URI'
  '/api/v2/hooks'            = 'webhook-uri (alta denumire)'
  '/api/v2/events'           = 'evenimente'
  '/api/v2/notifications'    = 'notificari'
  '/api/v2/customers?limit=1'= 'clienti (informativ)'
}

Write-Host ''
Write-Host "Magazin: $base" -ForegroundColor Cyan
Write-Host ''

foreach ($p in $paths.Keys) {
  $url = "$base$p"
  $status = $null
  $snippet = ''
  try {
    $resp = Invoke-WebRequest -Uri $url -Headers $headers -Method Get -UseBasicParsing -TimeoutSec 30
    $status = [int]$resp.StatusCode
    $snippet = ($resp.Content -replace '\s+', ' ')
    if ($snippet.Length -gt 160) { $snippet = $snippet.Substring(0, 160) + '...' }
  } catch {
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      try {
        $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd() -replace '\s+', ' '
        if ($body.Length -gt 160) { $body = $body.Substring(0, 160) + '...' }
        $snippet = $body
      } catch { $snippet = '' }
    } else {
      $status = 0
      $snippet = $_.Exception.Message
    }
  }

  $color = 'DarkGray'
  if ($status -eq 200) { $color = 'Green' }
  elseif ($status -eq 401 -or $status -eq 403) { $color = 'Yellow' }
  elseif ($status -eq 404) { $color = 'DarkGray' }
  elseif ($status -ge 500 -or $status -eq 0) { $color = 'Red' }

  Write-Host ("{0,-5} {1,-28} {2}" -f $status, $paths[$p], $p) -ForegroundColor $color
  if ($status -eq 200 -and $snippet) {
    Write-Host ("      $snippet") -ForegroundColor DarkGray
  }
}

Write-Host ''
Write-Host 'Cum se citeste:' -ForegroundColor Cyan
Write-Host '  200 = resursa exista si contul tau are acces la ea.'
Write-Host '  401/403 = resursa exista, dar contul nu are drepturi pe ea (se poate cere activarea).'
Write-Host '  404 = resursa nu exista in API.'
Write-Host ''
