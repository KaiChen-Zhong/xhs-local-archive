param(
  [string]$ExtensionId = "",

  [ValidateSet("Chrome", "Edge")]
  [string]$Browser = "Chrome"
)

$ErrorActionPreference = "Stop"

if ($ExtensionId -and $ExtensionId -notmatch "^[a-p]{32}$") {
  throw "ExtensionId must be a 32-character Chromium extension id using letters a-p."
}

if ($Browser -eq "Chrome") {
  $keyPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.xhs_archive.host"
} else {
  $keyPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.xhs_archive.host"
}

$registryKey = Get-Item -Path $keyPath -ErrorAction Stop
$manifestPath = $registryKey.GetValue("")
if (-not $manifestPath) {
  throw "Native host registry entry exists but default manifest path is empty."
}
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Native host manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$hostPath = [string]$manifest.path
$allowedOrigins = @($manifest.allowed_origins)

if ($manifest.name -ne "com.xhs_archive.host") {
  throw "Unexpected native host name: $($manifest.name)"
}
if ($manifest.type -ne "stdio") {
  throw "Unexpected native host type: $($manifest.type)"
}
if (-not $hostPath -or -not (Test-Path -LiteralPath $hostPath)) {
  throw "Native host executable path not found: $hostPath"
}
if ($ExtensionId) {
  $expectedOrigin = "chrome-extension://$ExtensionId/"
  if ($allowedOrigins -notcontains $expectedOrigin) {
    throw "Allowed origin mismatch. Expected $expectedOrigin, got $($allowedOrigins -join ', ')"
  }
}

[pscustomobject]@{
  ok = $true
  browser = $Browser
  registryKey = $keyPath
  manifestPath = $manifestPath
  hostPath = $hostPath
  allowedOrigins = $allowedOrigins
} | ConvertTo-Json -Depth 5
