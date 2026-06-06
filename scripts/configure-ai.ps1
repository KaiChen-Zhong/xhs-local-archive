param(
  [string]$TextBaseUrl = "",
  [string]$TextModel = "",
  [string]$TextApiKey = "",
  [string]$VisionBaseUrl = "",
  [string]$VisionModel = "",
  [string]$VisionApiKey = "",
  [switch]$UseTextForVision,
  [switch]$SkipTest
)

$ErrorActionPreference = "Stop"

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    if ($ptr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
  }
}

$root = Split-Path -Parent $PSScriptRoot
if (-not $TextBaseUrl) { $TextBaseUrl = Read-Host "Text AI Base URL" }
if (-not $TextModel) { $TextModel = Read-Host "Text AI Model" }
if (-not $TextApiKey) { $TextApiKey = Read-PlainSecret "Text AI API Key" }

if ($UseTextForVision) {
  $VisionBaseUrl = $TextBaseUrl
  $VisionModel = $TextModel
  $VisionApiKey = $TextApiKey
} else {
  if (-not $VisionBaseUrl) { $VisionBaseUrl = Read-Host "Vision AI Base URL (empty to skip)" }
  if ($VisionBaseUrl -and -not $VisionModel) { $VisionModel = Read-Host "Vision AI Model" }
  if ($VisionBaseUrl -and -not $VisionApiKey) { $VisionApiKey = Read-PlainSecret "Vision AI API Key" }
}

$payload = @{
  text = @{
    baseUrl = $TextBaseUrl.Trim()
    model = $TextModel.Trim()
    apiKey = $TextApiKey.Trim()
  }
  vision = @{
    baseUrl = $VisionBaseUrl.Trim()
    model = $VisionModel.Trim()
    apiKey = $VisionApiKey.Trim()
  }
} | ConvertTo-Json -Depth 5 -Compress

$env:XHS_CONFIGURE_AI_PAYLOAD = $payload
$script = @'
const { handleMessage } = require("./native-host/host.js");
(async () => {
  const ai = JSON.parse(process.env.XHS_CONFIGURE_AI_PAYLOAD || "{}");
  const saved = await handleMessage({ type: "saveSettings", settings: { ai } });
  if (!saved.ok) {
    console.log(JSON.stringify(saved, null, 2));
    process.exit(1);
  }
  const settings = await handleMessage({ type: "getSettings" });
  const result = { ok: true, settings };
  if (process.env.XHS_SKIP_AI_TEST !== "1") result.test = await handleMessage({ type: "testAiProvider" });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
'@
if ($SkipTest) { $env:XHS_SKIP_AI_TEST = "1" } else { $env:XHS_SKIP_AI_TEST = "0" }
try {
  Push-Location $root
  $script | node -
} finally {
  Pop-Location
  Remove-Item Env:\XHS_CONFIGURE_AI_PAYLOAD -ErrorAction SilentlyContinue
  Remove-Item Env:\XHS_SKIP_AI_TEST -ErrorAction SilentlyContinue
}
