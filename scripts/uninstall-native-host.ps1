param(
  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "All",

  [switch]$RemoveGeneratedManifest
)

$ErrorActionPreference = "Stop"

$targets = @()
if ($Browser -eq "Chrome" -or $Browser -eq "All") {
  $targets += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.xhs_archive.host"
}
if ($Browser -eq "Edge" -or $Browser -eq "All") {
  $targets += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.xhs_archive.host"
}

foreach ($keyPath in $targets) {
  if (Test-Path -LiteralPath $keyPath) {
    Remove-Item -LiteralPath $keyPath -Force
    Write-Host "Removed registry key: $keyPath"
  } else {
    Write-Host "Registry key absent: $keyPath"
  }
}

if ($RemoveGeneratedManifest) {
  $manifestPath = Join-Path $env:LOCALAPPDATA "XHSLocalArchive\NativeMessagingHosts\com.xhs_archive.host.json"
  if (Test-Path -LiteralPath $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force
    Write-Host "Removed generated manifest: $manifestPath"
  } else {
    Write-Host "Generated manifest absent: $manifestPath"
  }
}
