"use strict";

const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");
const eventsEl = document.getElementById("events");
const jobStatusEl = document.getElementById("jobStatus");
const captureHealthEl = document.getElementById("captureHealth");
const personaNameEl = document.getElementById("personaName");
const personaTextEl = document.getElementById("personaText");
const receiptEl = document.getElementById("receipt");
const achievementsEl = document.getElementById("achievements");
const notesEl = document.getElementById("notes");
const template = document.getElementById("noteCardTemplate");
const searchEl = document.getElementById("search");
const statusFilterEl = document.getElementById("statusFilter");
const categoryTrailEl = document.getElementById("categoryTrail");
const categoryChildrenEl = document.getElementById("categoryChildren");
const taxonomySummaryEl = document.getElementById("taxonomySummary");
const taxonomyListEl = document.getElementById("taxonomyList");
const mergeFromEl = document.getElementById("mergeFrom");
const mergeToEl = document.getElementById("mergeTo");
const themeEl = document.getElementById("theme");
let currentNotes = [];
let renderedNotes = [];
let activeCategoryPath = [];
let renderLimit = 160;
let refreshInFlight = false;
const viewCache = new Map();
const localCoverCache = new Map();
const INITIAL_RENDER_LIMIT = 160;
const RENDER_INCREMENT = 160;
const LOCAL_COVER_CACHE_LIMIT = 320;

document.getElementById("captureNow").addEventListener("click", () => send({ type: "captureNow" }));
document.getElementById("startScan").addEventListener("click", () => send({
  type: "startScan",
  options: {
    stepPx: 760,
    waitMs: 1200,
    stableRoundsToFinish: 10,
    maxMinutes: 360,
    maxNewNotes: 100000
  }
}));
document.getElementById("stopScan").addEventListener("click", () => send({ type: "stopScan" }));
document.getElementById("archiveAll").addEventListener("click", () => {
  const count = currentNotes.filter((note) => !note.markdownPath && !note.unavailableReason).length;
  if (!count) {
    statusEl.textContent = "没有可归档条目";
    return;
  }
  if (!confirm(`导出 ${Math.min(count, 10)} 条卡片元数据？只使用标题、封面、分类，不打开帖子。`)) return;
  send({ type: "archiveAll" });
});
document.getElementById("classifyAll").addEventListener("click", () => {
  const count = currentNotes.filter((note) => !note.unavailableReason && needsAiClassification(note)).length;
  if (!count) {
    statusEl.textContent = "没有可分类条目";
    return;
  }
  if (!confirm(`批量分类全部 ${count} 条待分类/异常条目？将先按标题和封面快速整理到五层以内受控分类。`)) return;
  send({ type: "classifyAll" });
});
document.getElementById("exportAll").addEventListener("click", () => exportAll());
document.getElementById("saveManualValidation").addEventListener("click", () => saveManualValidation());
document.getElementById("exportSelfTest").addEventListener("click", () => exportSelfTest());
document.getElementById("pingHost").addEventListener("click", () => pingHost());
document.getElementById("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("diagnosePage").addEventListener("click", () => send({ type: "diagnosePage" }));
document.getElementById("clearDiagnostics").addEventListener("click", () => send({ type: "clearDiagnostics" }));
document.getElementById("retryBackgroundJobs").addEventListener("click", () => send({ type: "retryBackgroundJobs" }));
document.getElementById("clearAllLocal").addEventListener("click", () => clearAllLocal());
document.getElementById("deleteFiltered").addEventListener("click", () => deleteFiltered());
document.getElementById("mergeTaxonomy").addEventListener("click", () => mergeTaxonomy());
document.getElementById("lockCurrentTaxonomy").addEventListener("click", () => lockCurrentTaxonomy());
searchEl.addEventListener("input", () => render(currentNotes, { resetLimit: true }));
statusFilterEl.addEventListener("change", () => render(currentNotes, { resetLimit: true }));
themeEl.addEventListener("change", () => saveTheme(themeEl.value));

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.scanStatus) {
    const value = changes.scanStatus.newValue;
    const expected = value.expectedTotal ? ` / 目标约 ${value.expectedTotal} / ${value.coveragePercent || 0}%` : "";
    const missing = ` / 缺标题 ${value.missingTitle || 0} / 缺封面 ${value.missingCover || 0}`;
    const scrollTarget = value.scrollTarget ? ` / 滚动 ${value.scrollTarget}` : "";
    statusEl.textContent = `扫描：${value.status}${value.reason ? ` / ${value.reason}` : ""}，已发现 ${value.knownCount || 0}${expected}${missing}${scrollTarget}`;
    renderCaptureHealth(value);
  }
  if (changes.backgroundJobStatus) {
    renderBackgroundJobStatus(changes.backgroundJobStatus.newValue);
  }
});

loadTheme();
initialize();
setInterval(refresh, 10000);

async function initialize() {
  await refreshBackgroundStatus();
  const repair = await chrome.runtime.sendMessage({ type: "repairLocalCache", reason: "sidepanel_load" }).catch(() => null);
  const recovered = repair && repair.classificationRecovery && repair.classificationRecovery.recovered;
  if (recovered) {
    statusEl.textContent = `未分类已自动整理：${repair.classificationRecovery.succeeded || 0}/${repair.classificationRecovery.unclassifiedBefore || 0}`;
  }
  if (repair && repair.ok && repair.rebuilt) {
    statusEl.textContent = `本地缓存已修复：${repair.total || 0} 条 / 补封面 ${repair.missingCover || 0} / 修正未分类 ${repair.staleUnclassified || 0}`;
  }
  await refresh();
}

async function send(payload) {
  const response = await chrome.runtime.sendMessage(payload).catch((error) => ({ ok: false, error: error.message }));
  if (!response.ok) statusEl.textContent = `错误：${describeError(response)}`;
  else statusEl.textContent = describeResponse(payload, response);
  await refresh();
}

function describeError(response) {
  const error = response.error || response.reason || "unknown";
  if (error === "risk_lock_active") {
    const seconds = Math.ceil(Number(response.remainingMs || 0) / 1000);
    return `${error}${response.reason ? ` / ${response.reason}` : ""}${seconds ? ` / 剩余 ${seconds}s` : ""}`;
  }
  if (error === "ai_settings_incomplete") return "AI 设置不完整：请在设置页保存并测试 Mimo 的 Base URL、Model、API Key";
  return error;
}

function describeResponse(payload, response) {
  if (payload.type === "captureNow") {
    return `手动采集：新增 ${response.count || 0} 条 / 候选 ${response.candidateCount || 0} / ${response.pageType || "unknown"}`;
  }
  if (payload.type === "startScan") {
    if (response.started) return `受控扫描已启动：候选 ${response.candidateCount || 0} / ${response.pageType || "unknown"}`;
    return `受控扫描未启动：${response.reason || "unknown"}`;
  }
  if (payload.type === "stopScan") return "扫描停止请求已发送";
  if (payload.type === "archiveAll") {
    const results = response.results || [];
    return `批量归档：${results.filter((item) => item.ok).length}/${results.length} 成功`;
  }
  if (payload.type === "classifyAll") {
    const results = response.results || [];
    const processed = Number.isFinite(response.processed) ? response.processed : results.length;
    const succeeded = Number.isFinite(response.succeeded) ? response.succeeded : results.filter((item) => item.ok).length;
    const failed = Number.isFinite(response.failed) ? response.failed : results.filter((item) => !item.ok).length;
    const failureText = failed ? ` / 失败 ${failed} 条，需重试或手动细分` : "";
    const truncated = response.truncatedResults ? " / 明细已截断，列表已刷新" : "";
    const mode = response.mode === "prefill" ? "快速整理" : "批量分类";
    return `${mode}：${succeeded}/${processed} 成功${failureText}${truncated}`;
  }
  if (payload.type === "classifyNote") {
    const ai = response.note && response.note.ai || {};
    const proposed = parsePath(ai.proposedCategoryPath || []);
    const path = parsePath(ai.categoryPath || []);
    if (ai.classificationIncomplete) return `AI 未能有效分类：${ai.providerError || "classification_incomplete"}`;
    if (ai.providerError) return `AI 异常，已用本地规则：${ai.providerError}`;
    if (ai.taxonomyPending && proposed.length) return `AI 分类待审：${proposed.join(" / ")}`;
    if (ai.aiPipeline && ai.aiPipeline.mode === "dual") return `AI 融合分类完成：${(path.length ? path : ["未分类", "待细分"]).join(" / ")}`;
    return `${ai.visionFallback ? "AI 分类完成（封面图像降级为链接）" : "AI 分类完成"}：${(path.length ? path : ["未分类", "待细分"]).join(" / ")}`;
  }
  if (payload.type === "updateClassification") return "分类已保存";
  if (payload.type === "mergeTaxonomy") return `分类已合并：更新 ${response.changed || 0} 条`;
  if (payload.type === "lockTaxonomy") return "分类已锁定";
  if (payload.type === "approveTaxonomyPath") return `分类已批准：更新 ${response.changed || 0} 条`;
  if (payload.type === "rejectPendingTaxonomy") return "待审分类已拒绝";
  if (payload.type === "archiveNote") return "单条归档完成";
  if (payload.type === "deleteLocal") return `本地删除：${(payload.noteIds || []).length} 条`;
  if (payload.type === "clearAllLocal") return `本地已清空：${response.deleted || 0} 条`;
  if (payload.type === "diagnosePage") {
    eventsEl.textContent = JSON.stringify(response.diagnostics || response, null, 2);
    const diagnostics = response.diagnostics || {};
    return `诊断：候选 ${diagnostics.candidateCount || 0} / anchor ${diagnostics.anchorCount || 0} / ${diagnostics.pageType || "unknown"}`;
  }
  if (payload.type === "clearDiagnostics") return "诊断已清空";
  if (payload.type === "retryBackgroundJobs") return "后台失败项已重新排队";
  return "操作完成";
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const response = await chrome.runtime.sendMessage({ type: "listNotes" }).catch((error) => ({ ok: false, error: error.message }));
  try {
    if (!response.ok) {
      statusEl.textContent = `列表读取失败：${response.error}`;
      return;
    }
    currentNotes = response.notes || [];
    if (response.classificationRecovery && response.classificationRecovery.recovered) {
      statusEl.textContent = `未分类已自动整理：${response.classificationRecovery.succeeded || 0}/${response.classificationRecovery.unclassifiedBefore || 0}`;
    }
    if (response.cacheRepair && response.cacheRepair.rebuilt) {
      statusEl.textContent = `本地缓存已同步：补封面 ${response.cacheRepair.missingCover || 0} / 修正未分类 ${response.cacheRepair.staleUnclassified || 0}`;
    }
    pruneViewCache(currentNotes);
    render(currentNotes);
    refreshReport();
    refreshInsights();
    refreshTaxonomy();
  } finally {
    refreshInFlight = false;
  }
}

async function refreshBackgroundStatus() {
  const data = await chrome.storage.session.get(["backgroundJobStatus", "scanStatus"]).catch(() => ({}));
  if (data.backgroundJobStatus) renderBackgroundJobStatus(data.backgroundJobStatus);
  if (data.scanStatus) renderCaptureHealth(data.scanStatus);
}

async function refreshReport() {
  const response = await chrome.runtime.sendMessage({ type: "getReport" }).catch(() => null);
  if (!response || !response.ok) return;
  const report = response.report;
  const counts = report.counts || {};
  const classified = Number.isFinite(report.classified) ? report.classified : classifiedCount(currentNotes);
  reportEl.textContent = `本地 ${report.total || 0} 条 · 已分类 ${classified} · 已导出 ${counts.archived || 0}`;
  renderEvents([...(report.events || []), ...(report.sessionEvents || [])]);
  renderStaticHealth(report);
}

function renderBackgroundJobStatus(job = {}) {
  if (!job || !job.type) {
    jobStatusEl.textContent = "后台归档空闲";
    return;
  }
  const failures = job.failures || [];
  const pending = Number(job.pending || 0);
  const processed = Number(job.processed || 0);
  const succeeded = Number(job.succeeded || 0);
  const reason = job.reason ? ` · ${job.reason}` : "";
  const failedText = failures.length ? ` · 失败 ${failures.length}（可重试）` : "";
  if (job.status === "running") {
    jobStatusEl.textContent = `后台归档中：已处理 ${processed}，成功 ${succeeded}，剩余约 ${pending}${failedText}${reason}`;
    return;
  }
  if (job.status === "failed_items") {
    const latest = failures[failures.length - 1];
    jobStatusEl.textContent = `后台归档有失败：${failures.length} 条，最新 ${latest && latest.noteId || "unknown"} / ${latest && latest.error || "unknown"}`;
    return;
  }
  if (job.status === "queued") {
    jobStatusEl.textContent = `后台归档已排队${reason}`;
    return;
  }
  jobStatusEl.textContent = `后台归档空闲：本轮成功 ${succeeded}${failedText}`;
}

function renderCaptureHealth(scan = {}) {
  const expected = Number(scan.expectedTotal || 0);
  const known = Number(scan.knownCount || 0);
  const missingTitle = Number(scan.missingTitle || 0);
  const missingCover = Number(scan.missingCover || 0);
  const missingUrl = Number(scan.missingUrl || 0);
  const coverage = expected ? `${Math.min(100, Math.round(known / expected * 1000) / 10)}%` : "未知";
  const warning = missingTitle || missingCover || missingUrl ? ` · 缺字段 标题${missingTitle}/封面${missingCover}/链接${missingUrl}` : " · 字段完整";
  captureHealthEl.textContent = `采集健康：覆盖 ${coverage}${expected ? `（${known}/${expected}）` : `（已发现 ${known}）`}${warning}`;
}

function renderStaticHealth(report = {}) {
  if (!currentNotes.length) {
    captureHealthEl.textContent = "采集健康：等待扫描";
    return;
  }
  const missingTitle = currentNotes.filter((note) => !note.title).length;
  const missingCover = currentNotes.filter((note) => !hasAnyCover(note)).length;
  const missingUrl = currentNotes.filter((note) => !note.url).length;
  const archived = report.counts && report.counts.archived || currentNotes.filter((note) => note.markdownPath).length;
  captureHealthEl.textContent = `采集健康：本地 ${currentNotes.length} · 已归档 ${archived} · 缺字段 标题${missingTitle}/封面${missingCover}/链接${missingUrl}`;
}

function renderEvents(events) {
  const lines = events
    .slice(-12)
    .reverse()
    .map((event) => `${event.ts || ""} ${event.level || ""} ${event.message || ""} ${JSON.stringify(event.meta || {})}`);
  eventsEl.textContent = lines.join("\n") || "暂无诊断事件";
}

async function refreshInsights() {
  const response = await chrome.runtime.sendMessage({ type: "getInsights" }).catch(() => null);
  if (!response || !response.ok) return;
  const insights = response.insights;
  personaNameEl.textContent = insights.persona.name;
  personaTextEl.textContent = insights.persona.description;
  receiptEl.innerHTML = "";
  for (const line of insights.receipt.lines || []) {
    const row = document.createElement("div");
    row.className = "receiptRow";
    row.innerHTML = `<span>${escapeHtml(line.label)}</span><strong>${line.percent}%</strong>`;
    receiptEl.appendChild(row);
  }
  achievementsEl.innerHTML = "";
  for (const achievement of insights.achievements || []) {
    const badge = document.createElement("span");
    badge.className = achievement.unlocked ? "badge unlocked" : "badge";
    badge.textContent = achievement.title;
    achievementsEl.appendChild(badge);
  }
}

async function refreshTaxonomy() {
  const response = await chrome.runtime.sendMessage({ type: "getTaxonomy" }).catch(() => null);
  if (!response || !response.ok) return;
  const entries = response.taxonomy && response.taxonomy.entries || [];
  const nodes = response.taxonomy && response.taxonomy.nodes || [];
  const pending = response.taxonomy && response.taxonomy.pendingNodes || [];
  const levelNames = response.taxonomy && response.taxonomy.levelNames || ["大类", "领域", "主题", "场景", "细项"];
  const locked = nodes.filter((node) => node.locked).length;
  taxonomySummaryEl.textContent = `${nodes.length} 个受控节点 · ${entries.length} 条可用路径 · ${locked} 节点锁定 · ${pending.length} 待审 · 五层：${levelNames.join(" > ")}`;
  taxonomyListEl.textContent = "";
  if (pending.length) {
    const title = document.createElement("div");
    title.className = "taxonomyGroupTitle";
    title.textContent = "待审新增：需要批准、拒绝或合并后才会进入受控分类";
    taxonomyListEl.appendChild(title);
  }
  for (const item of pending.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "taxonomyPending";
    const label = document.createElement("button");
    label.className = "taxonomyChip pending";
    label.textContent = `${item.path.join(" / ")} · ${item.count || 0}`;
    label.addEventListener("click", () => {
      mergeFromEl.value = item.path.join("/");
    });
    const approve = document.createElement("button");
    approve.className = "miniAction";
    approve.textContent = "批准";
    approve.addEventListener("click", () => approveTaxonomy(item.key));
    const reject = document.createElement("button");
    reject.className = "miniAction ghost";
    reject.textContent = "拒绝";
    reject.addEventListener("click", () => rejectPendingTaxonomy(item.key));
    row.append(label, approve, reject);
    taxonomyListEl.appendChild(row);
  }
  if (entries.length) {
    const title = document.createElement("div");
    title.className = "taxonomyGroupTitle";
    title.textContent = "受控分类";
    taxonomyListEl.appendChild(title);
  }
  for (const entry of entries.slice(0, 16)) {
    const chip = document.createElement("button");
    chip.className = entry.locked ? "taxonomyChip locked" : "taxonomyChip";
    chip.textContent = `${entry.path.join(" / ")} · ${entry.count || 0}${entry.locked ? " · 锁定" : ""}`;
    chip.addEventListener("click", () => {
      mergeFromEl.value = entry.path.join("/");
      if (!mergeToEl.value) mergeToEl.value = activeCategoryPath.join("/");
    });
    taxonomyListEl.appendChild(chip);
  }
}

function render(notes, options = {}) {
  if (options.resetLimit) renderLimit = INITIAL_RENDER_LIMIT;
  notesEl.textContent = "";
  renderCategoryNav(notes);
  renderedNotes = filterNotes(notes);
  if (!renderedNotes.length) {
    notesEl.innerHTML = "<p class=\"empty\">未发现帖子。打开小红书收藏/点赞页后点击采集。</p>";
    return;
  }
  const visibleNotes = renderedNotes.slice(0, renderLimit);
  const fragment = document.createDocumentFragment();
  for (const note of visibleNotes) {
    fragment.appendChild(renderNoteCard(note));
  }
  notesEl.appendChild(fragment);
  if (visibleNotes.length < renderedNotes.length) renderLoadMore(visibleNotes.length, renderedNotes.length);
}

function renderNoteCard(note) {
  const node = template.content.firstElementChild.cloneNode(true);
  const img = node.querySelector(".cover");
  setupCoverImage(img, note);
  const coverLink = node.querySelector(".coverLink");
  coverLink.disabled = !note.url;
  coverLink.title = note.url ? "在小红书中打开" : "缺少可用链接";
  coverLink.addEventListener("click", () => send({ type: "openNote", url: note.url || "" }));
  node.querySelector(".statusBadge").textContent = statusLabel(note);
  node.querySelector("h2").textContent = note.title || note.noteId;
  node.querySelector(".meta").textContent = `${note.author || "unknown"} · ${note.source || "unknown"}`;
  const classification = classificationOf(note);
  const classificationEl = node.querySelector(".classification");
  classificationEl.textContent = classificationLabel(note, classification);
  if (classification.pending) classificationEl.classList.add("pending");
  if (classification.error) classificationEl.classList.add("error");
  node.querySelector(".complete").textContent = completenessText(note);
  const pathInput = node.querySelector(".pathInput");
  pathInput.value = classification.path.join("/");
  node.querySelector(".classifyOne").addEventListener("click", () => send({ type: "classifyNote", noteId: note.noteId }));
  node.querySelector(".saveClassification").addEventListener("click", () => send({
    type: "updateClassification",
    noteId: note.noteId,
    classification: {
      categoryPath: parsePath(pathInput.value)
    }
  }));
  const archiveButton = node.querySelector(".archive");
  archiveButton.hidden = true;
  archiveButton.disabled = false;
  archiveButton.title = "后台会自动归档标题、封面、分类卡片";
  archiveButton.addEventListener("click", () => send({ type: "archiveNote", noteId: note.noteId }));
  node.querySelector(".deleteOne").addEventListener("click", () => deleteNotes([note.noteId]));
  return node;
}

function setupCoverImage(img, note) {
  const localCover = firstLocalImage(note);
  const remoteCover = note.cover || "";
  img.alt = note.title || "";
  img.loading = "lazy";
  img.hidden = !(localCover || remoteCover);
  img.onerror = () => {
    if (localCover && img.dataset.localCover !== localCover) {
      loadLocalCover(img, localCover, remoteCover);
      return;
    }
    img.hidden = true;
  };
  if (localCover) {
    loadLocalCover(img, localCover, remoteCover);
    return;
  }
  img.src = remoteCover;
}

function firstLocalImage(note) {
  const images = Array.isArray(note.localImages) ? note.localImages : [];
  return images.find((item) => typeof item === "string" && item.trim()) || "";
}

function hasAnyCover(note) {
  return Boolean(note && (note.cover || firstLocalImage(note)));
}

async function loadLocalCover(img, file, remoteFallback) {
  img.dataset.localCover = file;
  const cached = localCoverCache.get(file);
  if (cached) {
    img.src = cached;
    img.hidden = false;
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "readLocalMedia", file }).catch((error) => ({ ok: false, error: error.message }));
  if (img.dataset.localCover !== file) return;
  if (result && result.ok && result.dataUrl) {
    rememberLocalCover(file, result.dataUrl);
    img.src = result.dataUrl;
    img.hidden = false;
    return;
  }
  img.dataset.localCover = "";
  if (remoteFallback) {
    img.src = remoteFallback;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
}

function rememberLocalCover(file, dataUrl) {
  if (localCoverCache.size >= LOCAL_COVER_CACHE_LIMIT) {
    const firstKey = localCoverCache.keys().next().value;
    if (firstKey) localCoverCache.delete(firstKey);
  }
  localCoverCache.set(file, dataUrl);
}

function renderLoadMore(visible, total) {
  const wrapper = document.createElement("div");
  wrapper.className = "loadMore";
  const button = document.createElement("button");
  button.textContent = `继续显示 ${Math.min(RENDER_INCREMENT, total - visible)} 条（${visible}/${total}）`;
  button.addEventListener("click", () => {
    renderLimit += RENDER_INCREMENT;
    render(currentNotes);
  });
  wrapper.appendChild(button);
  notesEl.appendChild(wrapper);
}

function filterNotes(notes) {
  const keyword = searchEl.value.trim().toLowerCase();
  const status = statusFilterEl.value;
  return notes.filter((note) => {
    const view = noteView(note);
    const noteStatus = view.status;
    const classification = view.classification;
    if (status && noteStatus !== status) return false;
    if (!pathStartsWith(classification.path, activeCategoryPath)) return false;
    if (!keyword) return true;
    return view.searchText.includes(keyword);
  });
}

function renderCategoryNav(notes) {
  categoryTrailEl.textContent = activeCategoryPath.length ? `全部分类 / ${activeCategoryPath.join(" / ")}` : "全部分类";
  categoryTrailEl.onclick = () => {
    activeCategoryPath = [];
    render(currentNotes, { resetLimit: true });
  };
  if (activeCategoryPath.length && !mergeToEl.value) mergeToEl.value = activeCategoryPath.join("/");
  categoryChildrenEl.textContent = "";
  if (activeCategoryPath.length) {
    const up = document.createElement("button");
    up.textContent = "上一级";
    up.addEventListener("click", () => {
      activeCategoryPath = activeCategoryPath.slice(0, -1);
      render(currentNotes, { resetLimit: true });
    });
    categoryChildrenEl.appendChild(up);
  }
  for (const item of nextCategoryEntries(notes, activeCategoryPath)) {
    const button = document.createElement("button");
    button.textContent = `${item.name} (${item.count})`;
    button.addEventListener("click", () => {
      activeCategoryPath = [...activeCategoryPath, item.name].slice(0, 5);
      render(currentNotes, { resetLimit: true });
    });
    categoryChildrenEl.appendChild(button);
  }
}

function nextCategoryEntries(notes, prefix) {
  const counts = {};
  for (const note of notes) {
    const path = noteView(note).classification.path;
    if (!pathStartsWith(path, prefix)) continue;
    const next = path[prefix.length];
    if (!next) continue;
    counts[next] = (counts[next] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function pathStartsWith(path, prefix) {
  return prefix.every((item, index) => path[index] === item);
}

function classificationOf(note) {
  return noteView(note).classification;
}

function noteView(note) {
  const key = viewCacheKey(note);
  const cached = viewCache.get(note.noteId);
  if (cached && cached.key === key) return cached.view;
  const classification = computeClassification(note);
  const tags = Array.isArray(note.ai && note.ai.tags) ? note.ai.tags.slice(0, 12) : [];
  const status = statusOfRaw(note);
  const view = {
    classification,
    tags,
    status,
    classified: classification.path.join("/") !== "未分类/待细分",
    searchText: `${note.title || ""} ${note.author || ""} ${note.noteId || ""} ${classification.path.join(" ")} ${classification.proposedPath.join(" ")} ${tags.join(" ")}`.toLowerCase()
  };
  viewCache.set(note.noteId, { key, view });
  return view;
}

function viewCacheKey(note) {
  const ai = note.ai || {};
  return [
    note.noteId || "",
    note.updatedAt || note.createdAt || "",
    note.markdownPath || "",
    note.unavailableReason || "",
    Array.isArray(ai.categoryPath) ? ai.categoryPath.join("/") : "",
    Array.isArray(ai.proposedCategoryPath) ? ai.proposedCategoryPath.join("/") : "",
    Array.isArray(ai.tags) ? ai.tags.join("/") : "",
    ai.category || "",
    ai.subcategory || "",
    ai.providerError || "",
    ai.taxonomyPending ? "pending" : ""
  ].join("|");
}

function pruneViewCache(notes) {
  if (viewCache.size < 20000) return;
  const ids = new Set(notes.map((note) => note.noteId).filter(Boolean));
  for (const id of viewCache.keys()) {
    if (!ids.has(id)) viewCache.delete(id);
  }
}

function computeClassification(note) {
  const ai = note.ai || {};
  const path = parsePath(ai.categoryPath || ai.path || [ai.category, ai.subcategory]);
  const fallback = inferTaxonomy(note).path;
  return {
    path: path.length ? path : fallback,
    proposedPath: parsePath(ai.proposedCategoryPath || []),
    pending: Boolean(ai.taxonomyPending),
    error: ai.providerError || ""
  };
}

function needsAiClassification(note) {
  const ai = note && note.ai || {};
  if (!ai || !Object.keys(ai).length) return true;
  if (ai.providerError) return true;
  if (ai.source === "manual" || ai.source === "merge") return false;
  const path = parsePath(ai.categoryPath || [ai.category, ai.subcategory]);
  return !path.length || path.join("/") === "未分类/待细分" || isCoarseClassificationPath(path);
}

function isCoarseClassificationPath(path) {
  if (path.length <= 1) return true;
  return path.length === 2 && /^(待细分|其他|其它|未分类|综合)$/.test(path[1]);
}

function classificationLabel(note, classification) {
  if (classification.error) return `AI异常：${classification.error}`;
  if (classification.pending && classification.proposedPath.length) {
    return `分类待审：${classification.proposedPath.join(" / ")}（在分类治理中批准或合并）`;
  }
  return classification.path.join(" / ");
}

function parsePath(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[/>｜|,，]/);
  return raw.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5);
}

function inferTaxonomy(note) {
  const text = `${note.title || ""} ${note.cover || ""}`.toLowerCase();
  const rules = [
    [/咖啡|甜品|蛋糕|烘焙|奶茶|饮品|tea|coffee|cafe|cake/, ["美食", "咖啡甜品"]],
    [/餐厅|探店|火锅|烧烤|烤肉|日料|西餐|brunch|酒吧|bar/, ["美食", "餐厅探店"]],
    [/菜谱|做法|早餐|晚餐|减脂餐|便当|食谱|recipe/, ["美食", "家常烹饪"]],
    [/穿搭|ootd|搭配|裙|鞋|包|外套|牛仔|通勤|显瘦/, ["穿搭", "日常穿搭"]],
    [/美妆|妆容|口红|粉底|护肤|香水|发型|发色/, ["美妆", "妆容护肤"]],
    [/旅行|旅游|攻略|路线|酒店|民宿|机票|citywalk|露营/, ["旅行", "目的地攻略"]],
    [/家居|装修|收纳|软装|租房|房间|卧室|客厅/, ["家居", "装修收纳"]],
    [/健身|瑜伽|跑步|普拉提|减脂|运动|训练/, ["健康", "运动健身"]],
    [/学习|读书|考研|英语|笔记|效率|自律|课程/, ["学习", "知识成长"]],
    [/数码|手机|电脑|软件|app|ai|相机|键盘|耳机/, ["科技", "数码工具"]]
  ];
  for (const [pattern, path] of rules) {
    if (pattern.test(text)) return { path };
  }
  return { path: ["未分类", "待细分"] };
}

function statusOf(note) {
  return noteView(note).status;
}

function statusOfRaw(note) {
  if (note.markdownPath) return "archived";
  return "discovered";
}

function statusLabel(note) {
  if (note.unavailableReason) return "不可用";
  if (note.markdownPath) return "已导出";
  return "待导出";
}

function isArchivable(note) {
  return Boolean(note && note.noteId);
}

function completenessText(note) {
  const cover = hasAnyCover(note) ? "封面:有" : "封面:无";
  const classification = noteView(note).classification;
  const classified = classification.pending ? "分类:待审" : classification.path.join("/") === "未分类/待细分" ? "分类:待定" : "分类:有";
  const markdown = note.markdownPath ? "MD:有" : "MD:无";
  return `${cover} · ${classified} · ${markdown}`;
}

async function deleteFiltered() {
  const ids = renderedNotes.map((note) => note.noteId).filter(Boolean);
  if (!ids.length) return;
  if (!confirm(`只删除本地记录和本地文件索引，不会操作小红书。确认删除 ${ids.length} 条？`)) return;
  await deleteNotes(ids);
}

async function deleteNotes(noteIds) {
  await send({ type: "deleteLocal", noteIds });
}

async function clearAllLocal() {
  if (!confirm("清空所有本地采集、分类、导出记录？不会操作小红书账号内容。")) return;
  await send({ type: "clearAllLocal" });
}

async function mergeTaxonomy() {
  const from = mergeFromEl.value.trim();
  const to = mergeToEl.value.trim();
  if (!from || !to) {
    statusEl.textContent = "请填写合并来源和目标分类";
    return;
  }
  if (from === to) {
    statusEl.textContent = "来源和目标分类相同";
    return;
  }
  if (!confirm(`把「${from}」合并到「${to}」？会批量更新本地卡片分类。`)) return;
  await send({ type: "mergeTaxonomy", from, to });
  mergeFromEl.value = "";
}

async function lockCurrentTaxonomy() {
  const path = activeCategoryPath.length ? activeCategoryPath.join("/") : mergeToEl.value.trim();
  if (!path) {
    statusEl.textContent = "请先进入一个分类，或填写目标分类路径";
    return;
  }
  await send({ type: "lockTaxonomy", path });
}

async function approveTaxonomy(key) {
  if (!key) return;
  await send({ type: "approveTaxonomyPath", key });
}

async function rejectPendingTaxonomy(key) {
  if (!key) return;
  if (!confirm("拒绝这个待审分类？相关卡片会继续停留在现有受控父类。")) return;
  await send({ type: "rejectPendingTaxonomy", key });
}

async function exportAll() {
  const result = await chrome.runtime.sendMessage({ type: "exportAll" }).catch((error) => ({ ok: false, error: error.message }));
  statusEl.textContent = result.ok ? `全部数据备份已导出 ${result.count} 条：${result.indexPath}` : `导出失败：${result.error}`;
  await refresh();
}

async function exportSelfTest() {
  const result = await chrome.runtime.sendMessage({ type: "exportSelfTest" }).catch((error) => ({ ok: false, error: error.message }));
  statusEl.textContent = result.ok ? `自检已导出：${result.selfTestPath}` : `自检失败：${result.error}`;
  await refresh();
}

async function saveManualValidation() {
  const message = [
    "确认你已完成真实小红书登录态手测：",
    "1. 打开收藏/点赞页并触发采集或受控扫描",
    "2. 未出现扫码、验证、频繁访问或访问受限提示",
    "3. 至少一条收藏卡片已完成分类并导出"
  ].join("\n");
  if (!confirm(message)) return;
  const result = await chrome.runtime.sendMessage({
    type: "saveManualXhsValidation",
    validation: {
      passed: true,
      source: "sidepanel"
    }
  }).catch((error) => ({ ok: false, error: error.message }));
  statusEl.textContent = result.ok
    ? `手测记录已保存：${result.validation.recordedAt}`
    : `手测记录失败：${result.error}${result.prerequisites ? "，需先完成采集、分类和导出" : ""}`;
  await refresh();
}

async function pingHost() {
  const result = await chrome.runtime.sendMessage({ type: "pingHost" }).catch((error) => ({ ok: false, error: error.message }));
  statusEl.textContent = result.ok ? `宿主正常：${result.archiveRoot}` : `宿主异常：${result.error}`;
}

async function loadTheme() {
  const data = await chrome.storage.local.get(["theme"]).catch(() => ({ theme: "minimal" }));
  applyTheme(data.theme || "minimal");
}

async function saveTheme(theme) {
  await chrome.storage.local.set({ theme });
  applyTheme(theme);
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  themeEl.value = theme;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function classifiedCount(notes) {
  return notes.filter((note) => noteView(note).classified).length;
}
