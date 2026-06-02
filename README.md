# 小红书收藏本地整理助手

一个 Chrome/Edge MV3 浏览器扩展，配套 Native Messaging 本地宿主，用于把小红书收藏/点赞页中已经可见的卡片整理成本地分类库。当前实现只使用卡片标题和封面做 AI 分类，不自动打开帖子、不读取正文、不采集评论。

核心目标：

- 把收藏页卡片采集到本地。
- 按标题与封面自动归入五层以内受控分类树。
- 像 `界/门/纲/目/科` 一样逐层管理分类节点，避免同类内容被 AI 随机拆散。
- 在侧栏按大类、小类继续下钻浏览，保持小红书式瀑布流体验。
- 导出本地 Markdown、JSON、CSV、JSONL，便于长期保存和二次整理。

## Scope

已实现范围：

- 从可见 DOM 卡片和用户触发后的页面网络响应中发现收藏/点赞卡片。
- 分类只使用卡片标题和可见封面。
- 支持文本 AI、多模态 AI，二者都配置时先分别分析标题与封面，再融合裁决五层以内分类路径。
- 受控 taxonomy tree：每层都是受管节点，最多五层，层级名为 `大类 > 领域 > 主题 > 场景 > 细项`。
- 系统预置稳定大类与常见二级类，例如科技、金融、健康、美食、学习、生活等，作为初始受控根系。
- AI 必须逐层复用已有子节点；新 AI 路径进入待审，人工批准后才正式入库，不再用第一条 AI 结果自动创建正式根类。
- 支持待审分类批准、拒绝、合并、锁定。
- 默认页面加载时不持久采集；只有用户点击采集/扫描后才开始。
- 不自动打开帖子，不做详情页 hydration，不读取正文，不采集评论；用户可点击封面在当前浏览器登录态下手动打开对应小红书页面。
- 网络响应镜像仅在用户触发采集/扫描后开启。
- 网络响应镜像限定到小红书相关列表/卡片接口路径。
- 停止或风险事件后暂停镜像，直到用户再次启动采集。
- 受控扫描带停止按钮、冷却时间和单次发现上限；每次受控扫描会先清空页面内临时采集缓存并回到顶部。
- 默认单次扫描上限为 20000 条，适配万级收藏夹；状态栏会显示页面宣称总数、已发现数、覆盖比例、缺标题数和缺封面数。
- 如果页面宣称总数存在且扫描结束时发现数不足，停止原因会显示 `incomplete_expected_total`，不会误报 `complete`。
- DOM 卡片按页面视觉位置 `top/left` 排序后分配发现顺序，网络响应仍保留接口返回顺序。
- 卡片 URL 优先保存真实可见卡片上的 `xsec_token` 链接；封面提取支持普通 `<img>`、懒加载属性、`srcset` 和背景图兜底。
- 扫描默认值：自适应滚动步长、1.2 秒等待、20000 条卡片上限。
- 批量分类默认最多处理 50 条未分类或 AI 异常条目，重复点击会继续向后推进；Native Host 默认 5 并发。
- 文本 AI 与多模态 AI 的初步分析并行执行，再做融合裁决。
- 批量导出每次最多 10 条，并做节奏控制。
- 访问受限或验证提示会锁定新采集动作 15 分钟。
- 扩展侧 IndexedDB 本地缓存。
- Native Messaging 宿主负责本地 JSON 数据库、媒体缓存和 Markdown 写入。
- 侧栏瀑布流浏览，支持按分类逐层下钻。
- 本地删除只删除本地记录和本地文件，不操作小红书账号内容。
- 支持搜索、状态筛选、六套本地主题、单条/批量本地删除。
- 支持收藏人格卡、分类回执、成就、JSON 导出、Markdown 索引、Notion CSV、AI 知识库 JSONL。
- 支持扫描诊断与自检报告。

明确不做：

- 指纹伪装、验证码绕过、请求签名破解、反检测规避。
- 保证读取已删除、私密、受限或当前登录态不可访问的帖子。
- 保证任意快速手动滚动都不会漏掉尚未加载的卡片。

See [SAFETY.md](SAFETY.md) for platform-safety boundaries.

## Recommended Workflow

1. Load extension.
2. Install Native Messaging host.
3. Open Xiaohongshu favorites or likes page while logged in.
4. Click `受控扫描`.
5. Wait until scan stops with `complete`, or stop immediately if access warnings appear. Access-limited or verification stops lock collection actions for 15 minutes. For order-sensitive validation, start from a freshly cleared local library; the controlled scan will reset page-side temporary state and scroll back to the top before collecting.
6. Click `批量分类`; AI decides category paths up to five levels using only title and cover. If both text and vision AI are configured, text analysis and cover analysis run in parallel and are fused before taxonomy governance.
7. Use `分类治理` to approve pending AI proposals, reject noisy paths, lock stable nodes, or merge duplicates such as `餐饮/咖啡馆` into `美食/咖啡甜品`.
8. Drill into 大类/小类/更细分类 in the side panel waterfall view.
9. Click `导出卡片`; batch export asks for confirmation, processes at most 10 records per click, and does not open Xiaohongshu pages.
10. After real logged-in validation and at least one classified export, click `记录手测`, then `自检`; the self-test JSON records manual checklist evidence.

## Data Status

- `discovered`: card/link found.
- `archived`: Markdown/media local archive written.
- `partial-archived`: legacy/incomplete Markdown exists.
- `unavailable`: access blocked, deleted, restricted, or verification required.

## Install Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Load unpacked: `extension/`.
4. Copy extension ID.

## Install Native Host

Windows PowerShell:

```powershell
.\scripts\install-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID -Browser Chrome
.\scripts\verify-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID -Browser Chrome
```

For Edge:

```powershell
.\scripts\install-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID -Browser Edge
.\scripts\verify-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID -Browser Edge
```

The installer writes the browser Native Messaging manifest under:

```text
%LOCALAPPDATA%\XHSLocalArchive\NativeMessagingHosts\com.xhs_archive.host.json
```

Source manifest `native-host/com.xhs_archive.host.json` stays a placeholder for tests and review.

To remove the generated browser registration:

```powershell
.\scripts\uninstall-native-host.ps1 -Browser Chrome
.\scripts\uninstall-native-host.ps1 -Browser Edge
```

Add `-RemoveGeneratedManifest` only when you also want to delete the generated manifest file. This does not delete `%USERPROFILE%\XHS-Archive`.

macOS:

```bash
chmod +x scripts/*-native-host.sh
./scripts/install-native-host.sh YOUR_EXTENSION_ID Chrome
./scripts/verify-native-host.sh YOUR_EXTENSION_ID Chrome
```

For Edge on macOS, replace `Chrome` with `Edge`. To remove registration:

```bash
./scripts/uninstall-native-host.sh Chrome --remove-launcher
```

The macOS installer writes the generated manifest under:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.xhs_archive.host.json
```

Default archive directory on Windows:

```text
%USERPROFILE%\XHS-Archive
```

Override with:

```powershell
$env:XHS_ARCHIVE_DIR="D:\XHS-Archive"
```

Default archive directory on macOS:

```text
~/XHS-Archive
```

## Test

```bash
npm test
npm run check
npm run self-test
```

On Windows, `npm run check` completes all Node.js syntax checks and skips the macOS shell-script syntax step when Unix `sh` is not installed. On Git Bash, WSL, macOS, and Linux, that shell-script step runs normally.

Full local acceptance on Windows:

```powershell
.\scripts\run-acceptance.ps1
```

Current automated coverage:

- Shared note utilities.
- XHS-like JSON extraction for feed/card payloads.
- Native host data upsert/list/archive/report and controlled taxonomy approval/merge/lock.
- Native host batch classification preserves discovery-order result slots while using limited AI concurrency.
- Native host media download safety limits for private/local URLs.
- Chrome Native Messaging binary protocol ping.
- PowerShell install/verify/uninstall/acceptance script syntax parsing.
- Cross-platform check wrapper for macOS shell-script syntax.
- Content script VM harness for manual capture, visual discovery order, comment-only filtering, and dynamic risk stop.
- Service worker VM harness for risk lock and capture blocking.
- Page bridge VM harness for narrowed network mirroring and lookalike-domain rejection.
- OpenAI-compatible AI endpoint call with mock server.
- AI key persistence uses Windows DPAPI on Windows and a local random encryption key stored with restricted file permissions on other platforms; settings API does not return plaintext key.
- Extension manifest file references.
- Local E2E self-test for upsert -> archive Markdown -> export -> self-test report -> local delete.
- Acceptance runner for syntax checks, unit tests, local E2E, and Chrome extension-load smoke.
- Chrome headless extension-load smoke test can be run manually with the command below.

```powershell
$chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile=Join-Path $PWD '.tmp-chrome-profile'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
& $chrome --headless=new --disable-gpu --no-first-run --user-data-dir=$profile --disable-extensions-except="$PWD\extension" --load-extension="$PWD\extension" --dump-dom "chrome://version"
Remove-Item -LiteralPath $profile -Recurse -Force
```

## Acceptance Checklist

Local automated proof:

- `npm run check` passes.
- `npm test` passes.
- `npm run self-test` passes.
- Options page `检查本地宿主` returns `{ "ok": true }` after native host install.
- Options page `测试 AI` returns `{ "ok": true }` after AI provider config.
- Side panel `宿主` returns archive path.
- Side panel `诊断` shows `notes_discovered` when cards are captured.
- `写入 Markdown` creates files under `%USERPROFILE%\XHS-Archive\notes`.
- Discovery-only cards can be exported as title-cover classification records; no post opening is required.
- `删本地` removes local database entry and archived Markdown/media files only.
- `导出` writes JSON, Markdown index, Notion CSV, and AI knowledge JSONL under `%USERPROFILE%\XHS-Archive\exports`.
- `自检` writes an environment/report JSON under `%USERPROFILE%\XHS-Archive\exports`.
- Self-test JSON contains `acceptanceChecklist`.
- Self-test JSON also contains `manualXhsChecklist`; after at least one captured Markdown archive and clicking `记录手测`, user-verified items include `pass: true`, `recordedAt`, and `source`.

Manual Xiaohongshu proof:

- Open favorites/likes page while logged in.
- Click `受控扫描`.
- If status stops with `access_limited` or `verification_or_login_required`, pause and use normal browser flow.
- Click `批量分类` and confirm category paths appear.
- Drill into category levels and confirm filtered waterfall cards render.
