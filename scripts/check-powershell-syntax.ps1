$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$files = Get-ChildItem -LiteralPath $scriptDir -Filter "*.ps1" -File |
  Where-Object { $_.Name -ne "check-powershell-syntax.ps1" }

$failed = @()
foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors -and $errors.Count -gt 0) {
    $failed += [pscustomobject]@{
      file = $file.FullName
      errors = @($errors | ForEach-Object { $_.Message })
    }
  }
}

if ($failed.Count -gt 0) {
  $failed | ConvertTo-Json -Depth 5 | Write-Error
}

[pscustomobject]@{
  ok = $true
  checked = @($files | ForEach-Object { $_.Name })
} | ConvertTo-Json -Depth 3
