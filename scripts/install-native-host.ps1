param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [ValidateSet("Chrome", "Edge")]
  [string]$Browser = "Chrome"
)

$ErrorActionPreference = "Stop"

if ($ExtensionId -notmatch "^[a-p]{32}$") {
  throw "ExtensionId must be a 32-character Chromium extension id using letters a-p."
}

$root = Split-Path -Parent $PSScriptRoot
$hostDir = Join-Path $root "native-host"
$hostCmd = Join-Path $hostDir "host.cmd"
$installDir = Join-Path $env:LOCALAPPDATA "XHSLocalArchive\NativeMessagingHosts"
$manifestPath = Join-Path $installDir "com.xhs_archive.host.json"

$manifest = @{
  name = "com.xhs_archive.host"
  description = "Local archive host for XHS Archive extension"
  path = $hostCmd
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

if ($Browser -eq "Chrome") {
  $keyPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.xhs_archive.host"
} else {
  $keyPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.xhs_archive.host"
}

New-Item -Path $keyPath -Force | Out-Null
Set-ItemProperty -Path $keyPath -Name "(default)" -Value $manifestPath
Write-Host "Installed native host manifest: $manifestPath"
