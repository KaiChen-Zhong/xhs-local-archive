"use strict";

const DB_NAME = "xhs-local-archive";
const DB_VERSION = 1;
const STORE_NOTES = "notes";
const HOST_NAME = "com.xhs_archive.host";
const SCAN_COOLDOWN_MS = 30000;
const ARCHIVE_ALL_LIMIT = 10;
const ARCHIVE_ALL_DELAY_MS = 2000;
const AUTO_ARCHIVE_BATCH_LIMIT = 25;
const AUTO_ARCHIVE_DELAY_MS = 350;
const AUTO_ARCHIVE_FAILURE_LIMIT = 80;
const RISK_LOCK_MS = 15 * 60 * 1000;
let autoArchiveRunning = false;
let autoArchiveRequested = false;
let autoArchiveFailures = [];

recoverNativeState("service_worker_loaded");

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  recoverNativeState("installed_recovery");
  queueAutoArchive("installed_recovery");
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    recoverNativeState("startup_recovery");
    queueAutoArchive("startup_recovery");
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  if (!message || !message.type) return { ok: false, error: "missing_type" };

  if (message.type === "notesDiscovered") {
    const notes = Array.isArray(message.notes) ? message.notes : [];
    await upsertLocal(notes);
    const nativeResult = await sendNative({ type: "upsertNotes", notes }).catch((error) => ({ ok: false, error: error.message }));
    await appendEvent("info", "notes_discovered", {
      count: notes.length,
      nativeOk: Boolean(nativeResult && nativeResult.ok)
    });
    queueAutoArchive("notes_discovered");
    return { ok: true, count: notes.length };
  }

  if (message.type === "scanStatus") {
    await chrome.storage.session.set({ scanStatus: message });
    if (message.status === "stopped") {
      if (isRiskStopReason(message.reason)) await activateRiskLock(message.reason);
      await appendEvent("info", "scan_stopped", {
        reason: message.reason || "",
        knownCount: message.knownCount || 0,
        expectedTotal: message.expectedTotal || 0,
        coveragePercent: message.coveragePercent || 0,
        missingTitle: message.missingTitle || 0,
        missingCover: message.missingCover || 0,
        missingUrl: message.missingUrl || 0,
        scrollTarget: message.scrollTarget || ""
      });
      queueAutoArchive("scan_stopped");
    }
    return { ok: true };
  }

  if (message.type === "listNotes") {
    const localNotes = await listLocal();
    const native = await sendNative({ type: "listNotes" }).catch(() => null);
    const repair = native && native.ok ? await repairLocalCacheFromNative(localNotes, native.notes || [], { reason: "list_notes" }) : null;
    const notes = repair && repair.ok ? repair.notes : localNotes;
    const failedIds = new Set(autoArchiveFailures.map((item) => item.noteId).filter(Boolean));
    if ((notes || []).some((note) => !failedIds.has(note.noteId) && !note.markdownPath && !note.unavailableReason && isArchivableLocal(note))) {
      queueAutoArchive("list_notes_recovery");
    }
    return {
      ok: true,
      notes,
      cacheRepair: repair ? {
        rebuilt: Boolean(repair.rebuilt),
        staleUnclassified: repair.staleUnclassified,
        missingCover: repair.missingCover,
        missingNativeFields: repair.missingNativeFields
      } : null
    };
  }

  if (message.type === "repairLocalCache") {
    const localNotes = await listLocal().catch(() => []);
    const native = await sendNative({ type: "listNotes" }).catch((error) => ({ ok: false, error: error.message }));
    if (!native || !native.ok) return { ok: false, error: native && native.error || "native_list_failed" };
    const repair = await repairLocalCacheFromNative(localNotes, native.notes || [], {
      force: Boolean(message.force),
      reason: message.reason || "manual_repair"
    });
    return {
      ok: true,
      rebuilt: Boolean(repair.rebuilt),
      total: repair.notes.length,
      staleUnclassified: repair.staleUnclassified,
      missingCover: repair.missingCover,
      missingNativeFields: repair.missingNativeFields
    };
  }

  if (message.type === "archiveNote") {
    const result = await sendNative({ type: "archiveNote", noteId: message.noteId, ai: message.ai || null });
    if (result.ok && result.note) await upsertLocal([result.note]);
    await appendEvent(result.ok ? "info" : "error", "archive_note", {
      noteId: message.noteId,
      ok: Boolean(result.ok),
      error: result.error || ""
    });
    return result;
  }

  if (message.type === "archiveAll") {
    const { results } = await archivePendingCards({
      limit: ARCHIVE_ALL_LIMIT,
      delayMs: ARCHIVE_ALL_DELAY_MS
    });
    await appendEvent("info", "archive_all", { count: results.length, ok: results.filter((item) => item.ok).length });
    return { ok: true, results };
  }

  if (message.type === "classifyNote") {
    const result = await sendNative({ type: "classifyNote", noteId: message.noteId });
    if (result.ok && result.note) await upsertLocal([result.note]);
    await appendEvent(result.ok ? "info" : "error", "classify_note", {
      noteId: message.noteId,
      ok: Boolean(result.ok),
      error: result.error || ""
    });
    if (result.ok) queueAutoArchive("classify_note");
    return result;
  }

  if (message.type === "classifyAll") {
    await syncLocalNotesToNative();
    const result = await sendNative({ type: "classifyAll", forceUnclassified: true, prefillOnly: true });
    if (result.ok) {
      const native = await sendNative({ type: "listNotes" }).catch(() => null);
      if (native && native.ok) await repairLocalCacheFromNative(await listLocal().catch(() => []), native.notes || [], { reason: "classify_all" });
    }
    await appendEvent(result.ok ? "info" : "error", "classify_all", {
      ok: Boolean(result.ok),
      count: Number.isFinite(result.processed) ? result.processed : (result.results || []).length,
      succeeded: Number(result.succeeded || 0),
      failed: Number(result.failed || 0),
      error: result.error || ""
    });
    if (result.ok) queueAutoArchive("classify_all");
    return result;
  }

  if (message.type === "updateClassification") {
    const result = await sendNative({
      type: "updateClassification",
      noteId: message.noteId,
      classification: message.classification || {}
    });
    if (result.ok && result.note) await upsertLocal([result.note]);
    await appendEvent(result.ok ? "info" : "error", "update_classification", {
      noteId: message.noteId,
      ok: Boolean(result.ok),
      error: result.error || ""
    });
    if (result.ok) queueAutoArchive("update_classification");
    return result;
  }

  if (message.type === "getTaxonomy") {
    return sendNative({ type: "getTaxonomy" });
  }

  if (message.type === "mergeTaxonomy") {
    const result = await sendNative({
      type: "mergeTaxonomy",
      from: message.from || "",
      to: message.to || ""
    });
    if (result.ok) {
      const native = await sendNative({ type: "listNotes" }).catch(() => null);
      if (native && native.ok) await repairLocalCacheFromNative(await listLocal().catch(() => []), native.notes || [], { reason: "merge_taxonomy" });
    }
    await appendEvent(result.ok ? "info" : "error", "merge_taxonomy", {
      ok: Boolean(result.ok),
      changed: result.changed || 0,
      error: result.error || ""
    });
    return result;
  }

  if (message.type === "lockTaxonomy") {
    const result = await sendNative({ type: "lockTaxonomy", path: message.path || "" });
    await appendEvent(result.ok ? "info" : "error", "lock_taxonomy", {
      ok: Boolean(result.ok),
      error: result.error || ""
    });
    return result;
  }

  if (message.type === "approveTaxonomyPath") {
    const result = await sendNative({ type: "approveTaxonomyPath", key: message.key || "", path: message.path || "" });
    if (result.ok) {
      const native = await sendNative({ type: "listNotes" }).catch(() => null);
      if (native && native.ok) await repairLocalCacheFromNative(await listLocal().catch(() => []), native.notes || [], { reason: "approve_taxonomy" });
    }
    await appendEvent(result.ok ? "info" : "error", "approve_taxonomy_path", {
      ok: Boolean(result.ok),
      changed: result.changed || 0,
      error: result.error || ""
    });
    return result;
  }

  if (message.type === "rejectPendingTaxonomy") {
    const result = await sendNative({ type: "rejectPendingTaxonomy", key: message.key || "", path: message.path || "" });
    await appendEvent(result.ok ? "info" : "error", "reject_pending_taxonomy", {
      ok: Boolean(result.ok),
      error: result.error || ""
    });
    return result;
  }

  if (message.type === "retryBackgroundJobs") {
    autoArchiveFailures = [];
    await setBackgroundJobStatus({
      type: "auto_archive",
      status: "queued",
      reason: "manual_retry",
      failures: []
    });
    queueAutoArchive("manual_retry");
    return { ok: true };
  }

  if (message.type === "deleteLocal") {
    await deleteLocal(message.noteIds || []);
    await sendNative({ type: "deleteLocal", noteIds: message.noteIds || [] }).catch(() => null);
    await appendEvent("info", "delete_local", { count: (message.noteIds || []).length });
    return { ok: true };
  }

  if (message.type === "clearAllLocal") {
    const localNotes = await listLocal();
    await clearLocalNotes();
    const nativeList = await sendNative({ type: "listNotes" }).catch(() => null);
    const nativeIds = nativeList && nativeList.ok ? (nativeList.notes || []).map((note) => note.noteId).filter(Boolean) : [];
    if (nativeIds.length) await sendNative({ type: "deleteLocal", noteIds: nativeIds }).catch(() => null);
    const tabId = await activeTabId().catch(() => 0);
    if (tabId) await sendContentMessage(tabId, { type: "resetCapturedState" }).catch(() => null);
    const deleted = new Set([...localNotes.map((note) => note.noteId).filter(Boolean), ...nativeIds]).size;
    await appendEvent("info", "clear_all_local", { deleted });
    return { ok: true, deleted };
  }

  if (message.type === "readLocalMedia") {
    return sendNative({ type: "readLocalMedia", file: message.file || "" });
  }

  if (message.type === "startScan" || message.type === "stopScan" || message.type === "captureNow") {
    const tabId = message.tabId || sender.tab && sender.tab.id || await activeTabId();
    if (!tabId) return { ok: false, error: "no_active_tab" };
    if (message.type === "startScan" || message.type === "captureNow") {
      const riskLock = await checkRiskLock();
      if (!riskLock.ok) return riskLock;
    }
    if (message.type === "startScan") {
      const cooldown = await checkScanCooldown();
      if (!cooldown.ok) return cooldown;
      await chrome.storage.session.set({ lastScanStartAt: Date.now() });
    }
    const knownNotes = message.type === "startScan" || message.type === "captureNow"
      ? compactKnownNotes(await listLocal().catch(() => []))
      : [];
    const response = await sendContentMessage(tabId, { type: message.type, options: { ...(message.options || {}), knownNotes } });
    if (response && isRiskStopReason(response.reason)) await activateRiskLock(response.reason);
    await appendEvent(response && response.ok ? "info" : "error", `page_${message.type}`, {
      ok: Boolean(response && response.ok),
      reason: response && (response.reason || response.error) || "",
      count: response && response.count || 0,
      candidateCount: response && response.candidateCount || 0,
      pageType: response && response.pageType || "",
      diagnostics: response && response.diagnostics || null
    });
    return response;
  }

  if (message.type === "diagnosePage") {
    const tabId = message.tabId || sender.tab && sender.tab.id || await activeTabId();
    if (!tabId) return { ok: false, error: "no_active_tab" };
    const diagnostics = await sendContentMessage(tabId, { type: "diagnosePage" });
    await appendEvent(diagnostics && diagnostics.ok ? "info" : "error", "page_diagnose", {
      ok: Boolean(diagnostics && diagnostics.ok),
      diagnostics: diagnostics && diagnostics.diagnostics || null,
      error: diagnostics && diagnostics.error || ""
    });
    return diagnostics;
  }

  if (message.type === "openNote") {
    const url = String(message.url || "");
    if (!isAllowedXhsUrl(url)) return { ok: false, error: "invalid_xhs_url" };
    const tab = await chrome.tabs.create({ url, active: true });
    await appendEvent("info", "open_note", { tabId: tab.id || 0 });
    return { ok: true, tabId: tab.id || 0 };
  }

  if (message.type === "pingHost") {
    return sendNative({ type: "ping" });
  }

  if (message.type === "getSettings") {
    return sendNative({ type: "getSettings" });
  }

  if (message.type === "saveSettings") {
    return sendNative({
      type: "saveSettings",
      settings: message.settings || {},
      clearAiKey: Boolean(message.clearAiKey)
    });
  }

  if (message.type === "saveManualXhsValidation") {
    return sendNative({
      type: "saveManualXhsValidation",
      validation: message.validation || {}
    });
  }

  if (message.type === "testAiProvider") {
    return sendNative({ type: "testAiProvider" });
  }

  if (message.type === "getReport") {
    await syncLocalNotesToNative();
    const native = await sendNative({ type: "getReport" }).catch(() => null);
    const session = await chrome.storage.session.get(["debugEvents"]);
    if (native && native.ok) {
      return {
        ...native,
        report: {
          ...native.report,
          sessionEvents: session.debugEvents || []
        }
      };
    }
    const notes = await listLocal();
    return { ok: true, report: { ...buildLocalReport(notes), sessionEvents: session.debugEvents || [] } };
  }

  if (message.type === "getInsights") {
    await syncLocalNotesToNative();
    return sendNative({ type: "getInsights" });
  }

  if (message.type === "exportAll") {
    await syncLocalNotesToNative();
    const result = await sendNative({ type: "exportAll" });
    await appendEvent(result.ok ? "info" : "error", "export_all", {
      ok: Boolean(result.ok),
      count: result.count || 0,
      error: result.error || ""
    });
    return result;
  }

  if (message.type === "exportSelfTest") {
    const result = await sendNative({ type: "exportSelfTest" });
    await appendEvent(result.ok ? "info" : "error", "export_self_test", {
      ok: Boolean(result.ok),
      error: result.error || ""
    });
    return result;
  }

  if (message.type === "clearDiagnostics") {
    await chrome.storage.session.set({ debugEvents: [] });
    return { ok: true };
  }

  return { ok: false, error: `unknown_type:${message.type}` };
}

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] && tabs[0].id;
}

async function sendContentMessage(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    await injectContentScripts(tabId);
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

function isMissingContentScriptError(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(String(error && error.message || error || ""));
}

async function injectContentScripts(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !isAllowedXhsUrl(tab.url || "")) throw new Error("unsupported_active_tab");
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["xhs-extractors.js", "content-script.js"]
  });
}

async function recoverNativeState(reason) {
  const result = await sendNative({ type: "releaseClassificationLock", reason }).catch((error) => ({ ok: false, error: error.message }));
  await appendEvent(result.ok ? "info" : "error", "release_classification_lock", {
    reason,
    ok: Boolean(result.ok),
    released: Boolean(result.released),
    error: result.error || ""
  }).catch(() => {});
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NOTES)) db.createObjectStore(STORE_NOTES, { keyPath: "noteId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function upsertLocal(notes) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NOTES, "readwrite");
    const store = tx.objectStore(STORE_NOTES);
    let pending = 0;
    let done = false;
    const finish = () => {
      if (done || pending > 0) return;
      done = true;
    };
    for (const note of notes) {
      if (!note.noteId) continue;
      pending += 1;
      const getRequest = store.get(note.noteId);
      getRequest.onsuccess = () => {
        const merged = mergeNoteLocal(getRequest.result || {}, note);
        store.put(merged);
        pending -= 1;
        finish();
      };
      getRequest.onerror = () => {
        pending -= 1;
        finish();
      };
    }
    finish();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function mergeNoteLocal(existing, incoming) {
  const xsecToken = incoming.xsecToken || existing.xsecToken || "";
  const discoveryIndex = mergeDiscoveryIndexLocal(existing, incoming);
  return {
    ...existing,
    ...incoming,
    noteId: incoming.noteId || existing.noteId,
    title: incoming.title || existing.title || "",
    author: incoming.author || existing.author || "",
    text: incoming.text || existing.text || "",
    url: sourceUrlWithToken(incoming.url || existing.url || "", xsecToken),
    cover: incoming.cover || existing.cover || "",
    xsecToken,
    discoveryIndex,
    source: incoming.source || existing.source || "unknown",
    ai: mergeAiClassificationLocal(existing.ai, incoming.ai),
    images: unique([...(existing.images || []), ...(incoming.images || [])]),
    videos: unique([...(existing.videos || []), ...(incoming.videos || [])]),
    statuses: { ...(existing.statuses || {}), ...(incoming.statuses || {}) },
    createdAt: existing.createdAt || incoming.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function mergeAiClassificationLocal(existingAi, incomingAi) {
  if (!existingAi && !incomingAi) return undefined;
  if (!existingAi) return incomingAi;
  if (!incomingAi) return existingAi;
  const existingRank = classificationQualityRankLocal(existingAi);
  const incomingRank = classificationQualityRankLocal(incomingAi);
  const existingUnclassified = isUnclassifiedAiLocal(existingAi);
  const incomingUnclassified = isUnclassifiedAiLocal(incomingAi);
  if (!existingUnclassified && incomingUnclassified) return existingAi;
  if (existingUnclassified && !incomingUnclassified) return incomingAi;
  if (incomingRank > existingRank) return incomingAi;
  if (incomingRank < existingRank) return existingAi;
  const merged = { ...existingAi, ...incomingAi };
  if (!incomingAi.aiPipeline && existingAi.aiPipeline) merged.aiPipeline = existingAi.aiPipeline;
  if (!incomingAi.providerError && existingAi.providerError) merged.providerError = existingAi.providerError;
  if (!incomingAi.classificationIncomplete && existingAi.classificationIncomplete) merged.classificationIncomplete = existingAi.classificationIncomplete;
  return merged;
}

function classificationQualityRankLocal(ai = {}) {
  if (!ai || !Object.keys(ai).length) return 0;
  const path = parsePath(ai.categoryPath || [ai.category, ai.subcategory]);
  const unclassified = !path.length || path.join("/") === "未分类/待细分";
  const depth = unclassified ? 0 : Math.min(path.length, 5);
  if (unclassified) return 1;
  if (ai.source === "manual" || ai.source === "merge") return 50 + depth;
  if (!unclassified && /^ai/.test(String(ai.source || ""))) return 40 + depth;
  if (!unclassified) return 30 + depth;
  return 1;
}

function isUnclassifiedAiLocal(ai = {}) {
  const path = parsePath(ai && (ai.categoryPath || [ai.category, ai.subcategory]) || []);
  return !path.length || path.join("/") === "未分类/待细分";
}

function parsePath(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[/>｜|,，]/);
  return raw.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5);
}

function mergeDiscoveryIndexLocal(existing = {}, incoming = {}) {
  const existingIndex = Number(existing.discoveryIndex);
  const incomingIndex = Number(incoming.discoveryIndex);
  const hasExistingIndex = Number.isFinite(existingIndex);
  const hasIncomingIndex = Number.isFinite(incomingIndex);
  const incomingIsApi = isApiOrderedLocal(incoming);
  const existingIsApi = isApiOrderedLocal(existing);
  const incomingIsVisual = isVisualOrderedLocal(incoming);
  const existingIsVisual = isVisualOrderedLocal(existing);
  if (hasIncomingIndex && (
    !hasExistingIndex ||
    (incomingIsApi && !existingIsApi) ||
    (incomingIsApi && existingIsApi && incomingIndex < existingIndex) ||
    (incomingIsVisual && !existingIsApi && !existingIsVisual)
  )) return incomingIndex;
  if (hasExistingIndex) return existingIndex;
  return hasIncomingIndex ? incomingIndex : undefined;
}

function isApiOrderedLocal(note = {}) {
  return Boolean(note.statuses && note.statuses.apiOrdered);
}

function isVisualOrderedLocal(note = {}) {
  if (note.statuses && note.statuses.visualOrdered) return true;
  return /^(manual|start-scan|controlled-scan|mutation|scan-stop)$/.test(String(note.source || ""));
}

function sourceUrlWithToken(url, xsecToken) {
  const rawUrl = String(url || "");
  const token = String(xsecToken || "").trim();
  if (!rawUrl || !token) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if ((parsed.hostname === "xiaohongshu.com" || parsed.hostname.endsWith(".xiaohongshu.com")) && !parsed.searchParams.get("xsec_token")) {
      parsed.searchParams.set("xsec_token", token);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

async function listLocal() {
  const db = await openDb();
  const notes = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NOTES, "readonly");
    const request = tx.objectStore(STORE_NOTES).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return notes.sort(compareNotesByDiscoveryOrder);
}

function compactKnownNotes(notes) {
  return (notes || [])
    .filter((note) => note && note.noteId)
    .map((note) => ({
      noteId: note.noteId,
      title: note.title || "",
      author: note.author || "",
      url: note.url || "",
      cover: note.cover || "",
      xsecToken: note.xsecToken || "",
      discoveryIndex: Number.isFinite(Number(note.discoveryIndex)) ? Number(note.discoveryIndex) : undefined,
      source: note.source || "local",
      statuses: {
        discovered: true,
        seededLocal: true,
        apiOrdered: Boolean(note.statuses && note.statuses.apiOrdered),
        visualOrdered: Boolean(note.statuses && note.statuses.visualOrdered),
        collectionOrdered: Boolean(note.statuses && note.statuses.collectionOrdered)
      },
      createdAt: note.createdAt || new Date().toISOString(),
      updatedAt: note.updatedAt || ""
    }));
}

function compareNotesByDiscoveryOrder(a, b) {
  const aApi = isApiOrderedLocal(a);
  const bApi = isApiOrderedLocal(b);
  if (aApi !== bApi) return aApi ? -1 : 1;
  const aVisual = isVisualOrderedLocal(a);
  const bVisual = isVisualOrderedLocal(b);
  if (aVisual !== bVisual) return aVisual ? -1 : 1;
  const aIndex = Number(a.discoveryIndex);
  const bIndex = Number(b.discoveryIndex);
  if (Number.isFinite(aIndex) && Number.isFinite(bIndex) && aIndex !== bIndex) return aIndex - bIndex;
  if (Number.isFinite(aIndex) !== Number.isFinite(bIndex)) return Number.isFinite(aIndex) ? -1 : 1;
  const aTime = String(a.createdAt || a.updatedAt || "");
  const bTime = String(b.createdAt || b.updatedAt || "");
  return aTime.localeCompare(bTime) || String(a.noteId || "").localeCompare(String(b.noteId || ""));
}

async function deleteLocal(noteIds) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NOTES, "readwrite");
    const store = tx.objectStore(STORE_NOTES);
    for (const id of noteIds) store.delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function clearLocalNotes() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NOTES, "readwrite");
    tx.objectStore(STORE_NOTES).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function sendNative(payload) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (error) {
      reject(error);
      return;
    }
    const timeout = setTimeout(() => {
      try { port.disconnect(); } catch {}
      reject(new Error("native_host_timeout"));
    }, nativeTimeoutFor(payload && payload.type));
    port.onMessage.addListener((response) => {
      clearTimeout(timeout);
      resolve(response);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
    port.postMessage(payload);
  });
}

function nativeTimeoutFor(type) {
  if (type === "archiveNote") return 180000;
  if (type === "archiveAll") return 300000;
  if (type === "classifyAll") return 12 * 60 * 60 * 1000;
  if (type === "classifyNote") return 60000;
  if (type === "mergeTaxonomy") return 60000;
  if (type === "testAiProvider") return 60000;
  if (type === "exportAll" || type === "exportSelfTest") return 60000;
  return 15000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAllowedXhsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)xiaohongshu\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

function buildLocalReport(notes) {
  const counts = {};
  for (const note of notes) {
    const status = statusOfLocal(note);
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    total: notes.length,
    counts,
    archiveRoot: "",
    events: []
  };
}

function statusOfLocal(note) {
  if (note.unavailableReason) return "unavailable";
  if (note.markdownPath) return isArchivableLocal(note) ? "archived" : "partial-archived";
  return "discovered";
}

function isArchivableLocal(note) {
  return Boolean(note && note.noteId);
}

function queueAutoArchive(reason) {
  autoArchiveRequested = true;
  runAutoArchive(reason).catch((error) => {
    appendEvent("error", "auto_archive", { reason, error: error.message }).catch(() => {});
  });
}

async function runAutoArchive(reason) {
  if (autoArchiveRunning) return;
  autoArchiveRunning = true;
  let processedTotal = 0;
  let succeededTotal = 0;
  try {
    await setBackgroundJobStatus({
      type: "auto_archive",
      status: "running",
      reason,
      processed: 0,
      succeeded: 0,
      failures: autoArchiveFailures
    });
    while (autoArchiveRequested) {
      autoArchiveRequested = false;
      const result = await archivePendingCards({
        limit: AUTO_ARCHIVE_BATCH_LIMIT,
        delayMs: AUTO_ARCHIVE_DELAY_MS
      });
      processedTotal += result.results.length;
      succeededTotal += result.results.filter((item) => item.ok).length;
      if (result.results.length) {
        await appendEvent("info", "auto_archive", {
          reason,
          count: result.results.length,
          ok: result.results.filter((item) => item.ok).length,
          pending: result.remaining,
          hasMore: result.hasMore
        });
        autoArchiveFailures = [
          ...autoArchiveFailures,
          ...result.results
            .filter((item) => !item.ok)
            .map((item) => ({ noteId: item.noteId, error: item.error || "archive_failed" }))
        ].slice(-AUTO_ARCHIVE_FAILURE_LIMIT);
        await setBackgroundJobStatus({
          type: "auto_archive",
          status: result.hasMore ? "running" : "completed",
          reason,
          processed: processedTotal,
          succeeded: succeededTotal,
          pending: result.remaining,
          failures: autoArchiveFailures
        });
      }
      if (result.hasMore) {
        autoArchiveRequested = true;
        await sleep(AUTO_ARCHIVE_DELAY_MS);
      }
    }
    await setBackgroundJobStatus({
      type: "auto_archive",
      status: autoArchiveFailures.length ? "failed_items" : "idle",
      reason,
      processed: processedTotal,
      succeeded: succeededTotal,
      pending: 0,
      failures: autoArchiveFailures
    });
  } finally {
    autoArchiveRunning = false;
  }
}

async function archivePendingCards({ limit, delayMs }) {
  const localNotes = await listLocal().catch(() => []);
  const native = await sendNative({ type: "listNotes" }).catch(() => null);
  const nativeNotes = native && native.ok ? (native.notes || []) : [];
  const notes = native && native.ok ? mergeLocalAndNativeNotes(localNotes, nativeNotes) : localNotes;
  const nativeIds = new Set(nativeNotes.map((note) => note.noteId).filter(Boolean));
  const allCandidates = notes.filter((note) => !note.markdownPath && !note.unavailableReason && isArchivableLocal(note));
  const candidates = allCandidates.slice(0, limit);
  const results = [];
  const missingInNative = candidates.filter((note) => !nativeIds.has(note.noteId));
  if (missingInNative.length) {
    await sendNative({ type: "upsertNotes", notes: missingInNative }).catch(() => null);
  }
  for (let index = 0; index < candidates.length; index += 1) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    const note = candidates[index];
    const result = await sendNative({ type: "archiveNote", noteId: note.noteId }).catch((error) => ({ ok: false, error: error.message }));
    if (result.ok && result.note) await upsertLocal([result.note]);
    if (result.ok) autoArchiveFailures = autoArchiveFailures.filter((item) => item.noteId !== note.noteId);
    results.push({ noteId: note.noteId, ok: Boolean(result.ok), error: result.error || "" });
  }
  return {
    results,
    remaining: Math.max(0, allCandidates.length - candidates.length),
    hasMore: allCandidates.length > candidates.length
  };
}

async function syncLocalNotesToNative() {
  const localNotes = await listLocal().catch(() => []);
  if (!localNotes.length) return { ok: true, count: 0 };
  const native = await sendNative({ type: "listNotes" }).catch(() => null);
  if (native && native.ok) {
    const nativeNotes = native.notes || [];
    const nativeIds = new Set(nativeNotes.map((note) => note.noteId).filter(Boolean));
    const missingInNative = localNotes.filter((note) => note.noteId && !nativeIds.has(note.noteId));
    await repairLocalCacheFromNative(localNotes, nativeNotes, { reason: "sync_native" });
    if (!missingInNative.length) return { ok: true, count: 0, pulled: nativeNotes.length };
    const result = await sendNative({ type: "upsertNotes", notes: missingInNative }).catch((error) => ({ ok: false, error: error.message }));
    return {
      ok: Boolean(result && result.ok),
      count: missingInNative.length,
      pulled: nativeNotes.length,
      error: result && result.error || ""
    };
  }
  const result = await sendNative({ type: "upsertNotes", notes: localNotes }).catch((error) => ({ ok: false, error: error.message }));
  return { ok: Boolean(result && result.ok), count: localNotes.length, error: result && result.error || "" };
}

async function repairLocalCacheFromNative(localNotes, nativeNotes, options = {}) {
  const mergedNotes = mergeLocalAndNativeNotes(localNotes || [], nativeNotes || []);
  const stats = localCacheRepairStats(localNotes || [], nativeNotes || []);
  const rebuilt = Boolean(options.force || stats.needsRepair);
  if (rebuilt) {
    await clearLocalNotes();
    if (mergedNotes.length) await upsertLocal(mergedNotes);
    await appendEvent("info", "local_cache_repaired", {
      reason: options.reason || "",
      total: mergedNotes.length,
      staleUnclassified: stats.staleUnclassified,
      missingCover: stats.missingCover,
      missingNativeFields: stats.missingNativeFields
    });
  } else if (mergedNotes.length) {
    await upsertLocal(mergedNotes);
  }
  return {
    ok: true,
    rebuilt,
    notes: mergedNotes,
    staleUnclassified: stats.staleUnclassified,
    missingCover: stats.missingCover,
    missingNativeFields: stats.missingNativeFields
  };
}

function localCacheRepairStats(localNotes, nativeNotes) {
  const nativeById = new Map((nativeNotes || []).filter((note) => note && note.noteId).map((note) => [note.noteId, note]));
  let staleUnclassified = 0;
  let missingCover = 0;
  let missingNativeFields = 0;
  for (const local of localNotes || []) {
    if (!local || !local.noteId) continue;
    const native = nativeById.get(local.noteId);
    if (!native) continue;
    if (isUnclassifiedAiLocal(local.ai) && native.ai && !isUnclassifiedAiLocal(native.ai)) staleUnclassified += 1;
    if (!local.cover && native.cover) missingCover += 1;
    if ((!local.title && native.title) || (!(local.url || local.link || local.href) && (native.url || native.link || native.href))) {
      missingNativeFields += 1;
    }
  }
  const localIds = new Set((localNotes || []).map((note) => note && note.noteId).filter(Boolean));
  const nativeOnly = (nativeNotes || []).filter((note) => note && note.noteId && !localIds.has(note.noteId)).length;
  return {
    staleUnclassified,
    missingCover,
    missingNativeFields,
    nativeOnly,
    needsRepair: staleUnclassified > 0 || missingCover > 0 || missingNativeFields > 0 || (nativeNotes || []).length > 0 && nativeOnly > 0 && !(localNotes || []).length
  };
}

function mergeLocalAndNativeNotes(localNotes, nativeNotes) {
  const byId = new Map();
  for (const note of nativeNotes || []) {
    if (note && note.noteId) byId.set(note.noteId, note);
  }
  for (const note of localNotes || []) {
    if (!note || !note.noteId) continue;
    const nativeNote = byId.get(note.noteId);
    byId.set(note.noteId, nativeNote ? mergeNoteLocal(note, nativeNote) : note);
  }
  return Array.from(byId.values()).sort(compareNotesByDiscoveryOrder);
}

async function setBackgroundJobStatus(status) {
  await chrome.storage.session.set({
    backgroundJobStatus: {
      updatedAt: new Date().toISOString(),
      ...status,
      failures: (status.failures || []).slice(-AUTO_ARCHIVE_FAILURE_LIMIT)
    }
  });
}

async function appendEvent(level, message, meta = {}) {
  const event = {
    ts: new Date().toISOString(),
    level,
    message,
    meta: compactEventMeta(meta)
  };
  const current = await chrome.storage.session.get(["debugEvents"]);
  const events = current.debugEvents || [];
  events.push(event);
  await chrome.storage.session.set({ debugEvents: events.slice(-100) });
  await sendNative({ type: "logDiagnostic", event }).catch(() => null);
}

function compactEventMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  const json = JSON.stringify(meta);
  if (json.length <= 4000) return meta;
  return {
    truncated: true,
    sample: json.slice(0, 4000)
  };
}

async function checkScanCooldown() {
  const current = await chrome.storage.session.get(["lastScanStartAt"]);
  const last = Number(current.lastScanStartAt || 0);
  const remaining = SCAN_COOLDOWN_MS - (Date.now() - last);
  if (remaining <= 0) return { ok: true };
  await appendEvent("warn", "scan_cooldown", { remainingMs: remaining });
  return {
    ok: false,
    error: "scan_cooldown",
    remainingMs: remaining
  };
}

function isRiskStopReason(reason) {
  return reason === "access_limited" || reason === "verification_or_login_required";
}

async function activateRiskLock(reason) {
  const until = Date.now() + RISK_LOCK_MS;
  await chrome.storage.session.set({ riskLockUntil: until, riskLockReason: reason || "risk_stop" });
  await appendEvent("warn", "risk_lock_started", { reason, until });
}

async function checkRiskLock() {
  const current = await chrome.storage.session.get(["riskLockUntil", "riskLockReason"]);
  const until = Number(current.riskLockUntil || 0);
  const remaining = until - Date.now();
  if (remaining <= 0) return { ok: true };
  await appendEvent("warn", "risk_lock_active", {
    reason: current.riskLockReason || "",
    remainingMs: remaining
  });
  return {
    ok: false,
    error: "risk_lock_active",
    reason: current.riskLockReason || "",
    remainingMs: remaining
  };
}
