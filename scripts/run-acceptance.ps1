param(
  [switch]$SkipChromeSmoke
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  .\scripts\check-powershell-syntax.ps1
  npm run check
  if ($LASTEXITCODE -ne 0) { throw "npm run check failed with exit code $LASTEXITCODE" }
  npm test
  if ($LASTEXITCODE -ne 0) { throw "npm test failed with exit code $LASTEXITCODE" }
  npm run content-test
  if ($LASTEXITCODE -ne 0) { throw "npm run content-test failed with exit code $LASTEXITCODE" }
  npm run worker-test
  if ($LASTEXITCODE -ne 0) { throw "npm run worker-test failed with exit code $LASTEXITCODE" }
  npm run bridge-test
  if ($LASTEXITCODE -ne 0) { throw "npm run bridge-test failed with exit code $LASTEXITCODE" }
  npm run self-test
  if ($LASTEXITCODE -ne 0) { throw "npm run self-test failed with exit code $LASTEXITCODE" }

  if (-not $SkipChromeSmoke) {
    $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (-not (Test-Path -LiteralPath $chrome)) {
      throw "Chrome not found: $chrome"
    }
    $profile = Join-Path $root ".tmp-chrome-profile"
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    try {
      $output = & $chrome --headless=new --disable-gpu --no-first-run --user-data-dir=$profile --disable-extensions-except="$root\extension" --load-extension="$root\extension" --dump-dom "chrome://version" 2>&1
      $firstLine = $output | Select-Object -First 1
      Write-Output $firstLine
      $loadedDom = ($output -join "`n") -match "<!DOCTYPE html>"
      if ($LASTEXITCODE -ne 0 -and -not $loadedDom) {
        throw "Chrome extension smoke failed with exit code $LASTEXITCODE"
      }
    } finally {
      $resolved = Resolve-Path -LiteralPath $profile -ErrorAction SilentlyContinue
      if ($resolved -and $resolved.Path.StartsWith($root)) {
        for ($i = 0; $i -lt 10; $i += 1) {
          try {
            Remove-Item -LiteralPath $resolved.Path -Recurse -Force -ErrorAction Stop
            break
          } catch {
            Start-Sleep -Milliseconds 500
          }
        }
      }
    }
  }

  [pscustomobject]@{
    ok = $true
    powershellSyntax = "pass"
    check = "pass"
    tests = "pass"
    contentTest = "pass"
    workerTest = "pass"
    bridgeTest = "pass"
    selfTest = "pass"
    chromeSmoke = $(if ($SkipChromeSmoke) { "skipped" } else { "pass" })
  } | ConvertTo-Json -Depth 3
} finally {
  Pop-Location
}
