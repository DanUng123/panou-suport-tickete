# Diagnostic de unica folosinta -- NU face parte din aplicatie.
# Intreaba PTT Express ce servicii sunt disponibile pe contul tau, ca sa vedem
# daca exista un serviciu de tip "colet la schimb" (echivalentul SWAP de la
# Sameday sau Exchange/XS de la GLS). Ruleaza direct in PowerShell, fara Node.js.
#
# Rulare (din radacina proiectului):
#   powershell -ExecutionPolicy Bypass -File scripts\ptt-servicii.ps1 -User UTILIZATOR -Pass PAROLA
#
# Optional, cu un AWB existent, ca sa testam si eticheta de retur:
#   powershell -ExecutionPolicy Bypass -File scripts\ptt-servicii.ps1 -User UTILIZATOR -Pass PAROLA -Awb 51009530845

param(
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Pass,
  [string]$Awb
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

$url = 'https://api.pttexpress.ro/api.asmx'
$u = [System.Security.SecurityElement]::Escape($User)
$p = [System.Security.SecurityElement]::Escape($Pass)
$ready = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')

function Invoke-Ptt {
  param([string]$Operation, [string]$BodyXml)
  $envelope = @"
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
$BodyXml
  </soap:Body>
</soap:Envelope>
"@
  $resp = Invoke-WebRequest -Uri $url -Method Post -ContentType 'text/xml; charset=utf-8' `
    -Headers @{ 'SOAPAction' = "http://tempuri.org/$Operation" } -Body $envelope -UseBasicParsing
  return [xml]$resp.Content
}

function Get-Text {
  param($Xml, [string]$Tag)
  $nodes = $Xml.GetElementsByTagName($Tag)
  if ($nodes.Count -gt 0) { return $nodes[0].InnerText }
  return $null
}

# ---- 1. Serviciile disponibile pe cont ----

$servicesBody = @"
    <GetAvailableServices xmlns="http://tempuri.org/">
      <token><UserName>$u</UserName><Password>$p</Password></token>
      <getAvailableServicesRequest>
        <ReadyDate>$ready</ReadyDate>
        <ShipFrom>
          <Name>Expeditor Test</Name><Address>Strada Test 1</Address><City>Bucuresti</City>
          <PostCode>010101</PostCode><CountryCode>RO</CountryCode><Person>Expeditor Test</Person>
          <Contact>0700000000</Contact><Email>test@example.com</Email><IsPrivatePerson>false</IsPrivatePerson>
        </ShipFrom>
        <ShipTo>
          <Name>Destinatar Test</Name><Address>Strada Test 2</Address><City>Cluj-Napoca</City>
          <PostCode>400001</PostCode><CountryCode>RO</CountryCode><Person>Destinatar Test</Person>
          <Contact>0700000000</Contact><Email>test@example.com</Email><IsPrivatePerson>true</IsPrivatePerson>
        </ShipTo>
        <Parcels><Parcel><Type>Package</Type><Weight>1</Weight><D>20</D><W>15</W><S>10</S></Parcel></Parcels>
        <COD><Amount>0</Amount></COD>
        <InsuranceAmount>0</InsuranceAmount>
      </getAvailableServicesRequest>
    </GetAvailableServices>
"@

try {
  $xml = Invoke-Ptt -Operation 'GetAvailableServices' -BodyXml $servicesBody
} catch {
  Write-Host "Eroare la apelul GetAvailableServices: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$code = Get-Text $xml 'responseCode'
$desc = Get-Text $xml 'responseDescription'
if ($code -and $code -ne '0') {
  Write-Host "Raspuns cu eroare (cod $code): $desc" -ForegroundColor Yellow
} else {
  $services = $xml.GetElementsByTagName('Service')
  if ($services.Count -eq 0) {
    Write-Host 'Niciun serviciu returnat. XML brut:' -ForegroundColor Yellow
    Write-Host $xml.OuterXml.Substring(0, [Math]::Min(3000, $xml.OuterXml.Length))
  } else {
    Write-Host "Servicii disponibile pe contul tau ($($services.Count)):" -ForegroundColor Green
    Write-Host ''
    foreach ($s in $services) {
      $sid = $s.SelectSingleNode('*[local-name()="ID"]').InnerText
      $sname = $s.SelectSingleNode('*[local-name()="Name"]').InnerText
      $sprice = $s.SelectSingleNode('*[local-name()="Price"]')
      $priceText = if ($sprice) { $sprice.InnerText } else { '-' }
      Write-Host ("  ID {0,-6} {1,-45} {2}" -f $sid, $sname, $priceText)
    }
    Write-Host ''
    Write-Host 'Cautam ceva de tipul: schimb / swap / exchange / retur simultan.'
  }
}

# ---- 2. Optional: eticheta de retur pe un AWB existent ----

if ($Awb) {
  $awbEsc = [System.Security.SecurityElement]::Escape($Awb)
  $returnBody = @"
    <GetReturnLabel xmlns="http://tempuri.org/">
      <token><UserName>$u</UserName><Password>$p</Password></token>
      <getReturnLabelRequest>
        <PackageNo><string>$awbEsc</string></PackageNo>
        <ConsolidateLabels>false</ConsolidateLabels>
        <Format>PDFA4</Format>
      </getReturnLabelRequest>
    </GetReturnLabel>
"@
  try {
    $xml2 = Invoke-Ptt -Operation 'GetReturnLabel' -BodyXml $returnBody
    $code2 = Get-Text $xml2 'responseCode'
    $desc2 = Get-Text $xml2 'responseDescription'
    $mime = Get-Text $xml2 'MimeData'
    Write-Host ''
    Write-Host "GetReturnLabel pentru ${Awb}: cod $(if ($code2) { $code2 } else { '-' }), descriere: $(if ($desc2) { $desc2 } else { '-' })"
    if ($mime) {
      $bytes = [Math]::Round($mime.Length * 0.75)
      Write-Host "  -> eticheta de retur PRIMITA ($bytes octeti) - se poate emite un AWB de retur pe un colet existent." -ForegroundColor Green
    } else {
      Write-Host '  -> nicio eticheta returnata.' -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Eroare la apelul GetReturnLabel: $($_.Exception.Message)" -ForegroundColor Red
  }
}
