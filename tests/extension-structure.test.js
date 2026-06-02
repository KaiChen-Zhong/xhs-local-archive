"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("manifest references existing extension files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(root, "extension", manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(root, "extension", manifest.side_panel.default_path)));
  for (const item of manifest.content_scripts) {
    for (const file of item.js) {
      assert.ok(fs.existsSync(path.join(root, "extension", file)), file);
    }
  }
  for (const group of manifest.web_accessible_resources) {
    for (const file of group.resources) {
      assert.ok(fs.existsSync(path.join(root, "extension", file)), file);
    }
  }
});

test("native host manifest uses locked origin placeholder", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "native-host", "com.xhs_archive.host.json"), "utf8"));
  assert.equal(manifest.name, "com.xhs_archive.host");
  assert.deepEqual(manifest.allowed_origins, ["chrome-extension://REPLACE_WITH_EXTENSION_ID/"]);
});

test("native host installer writes generated manifest outside source tree", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-native-host.ps1"), "utf8");
  assert.match(installer, /\$env:LOCALAPPDATA/);
  assert.match(installer, /XHSLocalArchive\\NativeMessagingHosts/);
  assert.match(installer, /\^\[a-p\]\{32\}\$/);
  assert.match(installer, /Set-ItemProperty/);
  assert.doesNotMatch(installer, /\$manifestPath\s*=\s*Join-Path\s+\$hostDir/);
});

test("native host verifier checks registry manifest and origin", () => {
  const verifier = fs.readFileSync(path.join(root, "scripts", "verify-native-host.ps1"), "utf8");
  assert.match(verifier, /Get-Item -Path \$keyPath/);
  assert.match(verifier, /ConvertFrom-Json/);
  assert.match(verifier, /Allowed origin mismatch/);
  assert.match(verifier, /Test-Path -LiteralPath \$hostPath/);
});

test("native host uninstaller removes browser registry keys only", () => {
  const uninstaller = fs.readFileSync(path.join(root, "scripts", "uninstall-native-host.ps1"), "utf8");
  assert.match(uninstaller, /NativeMessagingHosts\\com\.xhs_archive\.host/);
  assert.match(uninstaller, /Remove-Item -LiteralPath \$keyPath -Force/);
  assert.match(uninstaller, /RemoveGeneratedManifest/);
  assert.doesNotMatch(uninstaller, /Remove-Item -LiteralPath \$env:USERPROFILE/);
});

test("macOS native host scripts install outside source and verify protocol ping", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-native-host.sh"), "utf8");
  const verifier = fs.readFileSync(path.join(root, "scripts", "verify-native-host.sh"), "utf8");
  const uninstaller = fs.readFileSync(path.join(root, "scripts", "uninstall-native-host.sh"), "utf8");
  assert.match(installer, /Google\/Chrome\/NativeMessagingHosts/);
  assert.match(installer, /XHSLocalArchive/);
  assert.match(installer, /\^\[a-p\]\{32\}\$/);
  assert.match(verifier, /type:\s*"ping"/);
  assert.match(verifier, /Allowed origin mismatch/);
  assert.match(uninstaller, /--remove-launcher/);
  assert.doesNotMatch(uninstaller, /XHS-Archive/);
});

test("acceptance runner covers checks tests self-test and extension smoke", () => {
  const runner = fs.readFileSync(path.join(root, "scripts", "run-acceptance.ps1"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(runner, /check-powershell-syntax\.ps1/);
  assert.match(runner, /npm run check/);
  assert.match(runner, /npm test/);
  assert.match(runner, /npm run content-test/);
  assert.match(runner, /npm run worker-test/);
  assert.match(runner, /npm run bridge-test/);
  assert.match(runner, /npm run self-test/);
  assert.match(runner, /LASTEXITCODE -ne 0/);
  assert.match(runner, /--load-extension="\$root\\extension"/);
  assert.match(runner, /loadedDom/);
  assert.match(runner, /SkipChromeSmoke/);
  const psSyntax = fs.readFileSync(path.join(root, "scripts", "check-powershell-syntax.ps1"), "utf8");
  assert.match(psSyntax, /System\.Management\.Automation\.Language\.Parser/);
  assert.match(psSyntax, /ParseFile/);
  assert.match(pkg.scripts.check, /check-shell-syntax\.js/);
  assert.equal(fs.existsSync(path.join(root, "scripts", "check-shell-syntax.js")), true);
});

test("extension keeps conservative scan and long archive safeguards", () => {
  const contentScript = fs.readFileSync(path.join(root, "extension", "content-script.js"), "utf8");
  const serviceWorker = fs.readFileSync(path.join(root, "extension", "service-worker.js"), "utf8");
  const sidePanel = fs.readFileSync(path.join(root, "extension", "sidepanel.js"), "utf8");
  const sidePanelHtml = fs.readFileSync(path.join(root, "extension", "sidepanel.html"), "utf8");
  assert.match(contentScript, /stepPx:\s*760/);
  assert.match(contentScript, /waitMs:\s*1200/);
  assert.match(contentScript, /maxNewNotes:\s*20000/);
  assert.match(contentScript, /coveragePercent/);
  assert.match(contentScript, /missingCover/);
  assert.match(contentScript, /incomplete_expected_total/);
  assert.match(contentScript, /lastScrollHeight/);
  assert.match(contentScript, /rememberNote/);
  assert.match(contentScript, /page_hidden/);
  assert.match(contentScript, /unexpected_domain/);
  assert.match(contentScript, /access_limited/);
  assert.match(contentScript, /bridgeInjected:\s*false/);
  assert.match(contentScript, /collectionEnabled:\s*false/);
  assert.match(contentScript, /collectionMode:\s*"idle"/);
  assert.doesNotMatch(contentScript, /captureVisibleCards\("initial"\)/);
  assert.doesNotMatch(contentScript, /type:\s*"contentReady"/);
  assert.doesNotMatch(contentScript, /hydrate-open/);
  assert.doesNotMatch(contentScript, /captureVisibleDetail/);
  assert.match(contentScript, /const result = enableCollection\("manual", true, "list"\)/);
  assert.match(contentScript, /count:\s*result\.notes\.length/);
  assert.match(contentScript, /candidateCount:\s*result\.candidates/);
  assert.match(contentScript, /pageType:\s*result\.pageType/);
  assert.match(contentScript, /function injectBridgeAndEnable\(\)/);
  assert.match(contentScript, /script\.onload = \(\) => \{[\s\S]*if \(STATE\.collectionEnabled\) setBridgeActive\(true\)/);
  assert.match(contentScript, /function pageType\(\)/);
  assert.match(contentScript, /profile-favorites/);
  assert.doesNotMatch(contentScript, /const notes = captureVisibleCards\("manual"\)/);
  assert.match(contentScript, /function cardOnlyNote\(note\)/);
  assert.doesNotMatch(contentScript, /currentDetailContext/);
  assert.match(contentScript, /type === "enableNetworkCapture"/);
  assert.match(contentScript, /count:\s*0,\s*reason:\s*safetyStop/);
  assert.match(contentScript, /started:\s*false,\s*reason:\s*safetyStop/);
  assert.match(contentScript, /started:\s*true/);
  assert.match(contentScript, /new MutationObserver[\s\S]*const safetyStop = detectSafetyStop\(\);[\s\S]*reportSafetyStop\(safetyStop\);[\s\S]*captureVisibleCards\("mutation"\)/);
  assert.match(contentScript, /function reportSafetyStop\(reason\)/);
  assert.match(contentScript, /function setBridgeActive\(active\)/);
  assert.match(contentScript, /source:\s*"xhs-local-archive-control"/);
  assert.match(contentScript, /setBridgeActive\(true\)/);
  assert.match(contentScript, /setBridgeActive\(false\)/);
  assert.match(contentScript, /STATE\.collectionEnabled = false;[\s\S]*STATE\.collectionMode = "idle";[\s\S]*type:\s*"scanStatus"/);
  assert.match(contentScript, /return \{ ok: false, started: false, reason: safetyStop \};[\s\S]*STATE\.scanActive = true;[\s\S]*enableCollection\("start-scan", true, "list"\);/);
  assert.match(contentScript, /if \(STATE\.collectionEnabled\) captureVisibleCards\("scan-stop"\)/);
  assert.match(contentScript, /\(\^\|\\\.\)xiaohongshu\\\.com\$/);
  const pageBridge = fs.readFileSync(path.join(root, "extension", "page-bridge.js"), "utf8");
  assert.match(pageBridge, /\(\^\|\\\.\)xiaohongshu\\\.com\$/);
  assert.match(pageBridge, /CAPTURE_PATH_PATTERN/);
  assert.match(pageBridge, /CAPTURE_QUERY_PATTERN/);
  assert.match(pageBridge, /let bridgeActive = false/);
  assert.match(pageBridge, /source !== "xhs-local-archive-control"/);
  assert.match(pageBridge, /if \(!bridgeActive\) return false/);
  assert.match(serviceWorker, /SCAN_COOLDOWN_MS\s*=\s*30000/);
  assert.doesNotMatch(serviceWorker, /HYDRATE_OPEN_COOLDOWN_MS/);
  assert.match(serviceWorker, /ARCHIVE_ALL_LIMIT\s*=\s*10/);
  assert.match(serviceWorker, /ARCHIVE_ALL_DELAY_MS\s*=\s*2000/);
  assert.match(serviceWorker, /RISK_LOCK_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
  assert.match(serviceWorker, /isRiskStopReason\(message\.reason\)/);
  assert.match(serviceWorker, /activateRiskLock\(message\.reason\)/);
  assert.match(serviceWorker, /risk_lock_started/);
  assert.match(serviceWorker, /risk_lock_active/);
  assert.match(serviceWorker, /const response = await sendContentMessage/);
  assert.match(serviceWorker, /function isMissingContentScriptError\(error\)/);
  assert.match(serviceWorker, /chrome\.scripting\.executeScript/);
  assert.match(serviceWorker, /response && isRiskStopReason\(response\.reason\)/);
  assert.match(serviceWorker, /archiveNote.*180000/s);
  assert.match(serviceWorker, /slice\(0, ARCHIVE_ALL_LIMIT\)/);
  assert.match(serviceWorker, /await sleep\(ARCHIVE_ALL_DELAY_MS\)/);
  assert.match(serviceWorker, /archiveAll.*300000/s);
  assert.doesNotMatch(serviceWorker, /message\.type === "openHydrate"/);
  assert.doesNotMatch(serviceWorker, /checkHydrateOpenCooldown/);
  assert.doesNotMatch(serviceWorker, /hydrate_open_cooldown/);
  assert.doesNotMatch(serviceWorker, /message\.type === "openSource"/);
  assert.match(serviceWorker, /isAllowedXhsUrl/);
  assert.doesNotMatch(serviceWorker, /message\.type === "contentReady"/);
  assert.match(serviceWorker, /message\.type === "startScan" \|\| message\.type === "captureNow"/);
  assert.match(serviceWorker, /message\.type === "saveManualXhsValidation"/);
  assert.doesNotMatch(serviceWorker, /pruneHydrateUrls/);
  assert.match(sidePanelHtml, /id="saveManualValidation"/);
  assert.match(sidePanel, /describeResponse/);
  assert.match(sidePanel, /stepPx:\s*760/);
  assert.match(sidePanel, /waitMs:\s*1200/);
  assert.match(sidePanel, /maxNewNotes:\s*20000/);
  assert.match(sidePanel, /目标约/);
  assert.match(sidePanel, /缺标题/);
  assert.match(sidePanel, /五层/);
  assert.match(sidePanelHtml, /id="openSettings"/);
  assert.match(sidePanelHtml, /id="clearAllLocal"/);
  assert.match(serviceWorker, /message\.type === "clearAllLocal"/);
  assert.match(serviceWorker, /clearLocalNotes/);
  assert.match(serviceWorker, /resetCapturedState/);
  assert.match(sidePanel, /Math\.min\(count, 10\)/);
  assert.match(sidePanel, /不打开帖子/);
  assert.match(sidePanel, /手动采集：新增/);
  assert.match(sidePanel, /候选/);
  assert.match(sidePanel, /批量归档：/);
  assert.match(sidePanel, /activeCategoryPath/);
  assert.match(sidePanel, /categoryPath/);
  assert.doesNotMatch(sidePanel, /补全页面已打开/);
  assert.doesNotMatch(sidePanelHtml, /打开补全/);
  assert.doesNotMatch(sidePanelHtml, /原帖/);
  assert.match(sidePanel, /saveManualValidation/);
  assert.match(sidePanel, /真实小红书登录态手测/);
  assert.match(sidePanel, /需先完成采集、分类和导出/);
  assert.equal(fs.existsSync(path.join(root, "extension", "viewer.js")), false);
  assert.equal(fs.existsSync(path.join(root, "extension", "viewer.html")), false);
});
