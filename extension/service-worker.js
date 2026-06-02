"use strict";

const DB_NAME = "xhs-local-archive";
const DB_VERSION = 1;
const STORE_NOTES = "notes";
const HOST_NAME = "com.xhs_archive.host";
const SCAN_COOLDOWN_MS = 30000;
const ARCHIVE_ALL_LIMIT = 10;
const ARCHIVE_ALL_DELAY_MS = 2000;
const CLASSIFY_ALL_LIMIT = 50;
const RISK_LOCK_MS = 15 * 60 * 1000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

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
    return { ok: true, count: notes.length };
  }

  if (message.type === "scanStatus") {
    await chrome.storage.session.set({ scanStatus: message });
    if (message.status === "stopped") {
      if (isRiskStopReason(message.reason)) await activateRiskLock(message.reason);
      await appendEvent("info", "scan_stopped", {
        reason: message.reason || "",
        knownCount: message.knownCount || 0
      });
    }
    return { ok: true };
  }

  if (message.type === "listNotes") {
    const localNotes = await listLocal();
    const native = await sendNative({ type: "listNotes" }).catch(() => null);
    return { ok: true, notes: native && native.ok ? native.notes : localNotes };
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
    const notes = await listLocal();
    const candidates = notes.filter((note) => !note.markdownPath && !note.unavailableReason && isArchivableLocal(note)).slice(0, ARCHIVE_ALL_LIMIT);
    const results = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if (index > 0) await sleep(ARCHIVE_ALL_DELAY_MS);
      const note = candidates[index];
      const result = await sendNative({ type: "archiveNote", noteId: note.noteId }).catch((error) => ({ ok: false, error: error.message }));
      if (result.ok && result.note) await upsertLocal([result.note]);
      results.push({ noteId: note.noteId, ok: Boolean(result.ok), error: result.error || "" });
    }
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
    return result;
  }

  if (message.type === "classifyAll") {
    const result = await sendNative({ type: "classifyAll", limit: CLASSIFY_ALL_LIMIT });
    if (result.ok) {
      const native = await sendNative({ type: "listNotes" }).catch(() => null);
      if (native && native.ok) await upsertLocal(native.notes || []);
    }
    await appendEvent(result.ok ? "info" : "error", "classify_all", {
      ok: Boolean(result.ok),
      count: (result.results || []).length,
      error: result.error || ""
    });
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
      if (native && native.ok) await upsertLocal(native.notes || []);
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
      if (native && native.ok) await upsertLocal(native.notes || []);
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

  if (message.type === "deleteLocal") {
    await deleteLocal(message.noteIds || []);
    await sendNative({ type: "deleteLocal", noteIds: message.noteIds || [] }).catch(() => null);
    await appendEvent("info", "delete_local", { count: (message.noteIds || []).length });
    return { ok: true };
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
    const response = await sendContentMessage(tabId, { type: message.type, options: message.options || null });
    if (response && isRiskStopReason(response.reason)) await activateRiskLock(response.reason);
    return response;
  }

  if (message.type === "diagnosePage") {
    const tabId = message.tabId || sender.tab && sender.tab.id || await activeTabId();
    if (!tabId) return { ok: false, error: "no_active_tab" };
    return sendContentMessage(tabId, { type: "diagnosePage" });
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
    return sendNative({ type: "getInsights" });
  }

  if (message.type === "exportAll") {
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
    source: incoming.source || existing.source || "unknown",
    images: unique([...(existing.images || []), ...(incoming.images || [])]),
    videos: unique([...(existing.videos || []), ...(incoming.videos || [])]),
    statuses: { ...(existing.statuses || {}), ...(incoming.statuses || {}) },
    createdAt: existing.createdAt || incoming.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
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
  return notes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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
  if (type === "classifyAll") return 300000;
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

async function appendEvent(level, message, meta = {}) {
  const current = await chrome.storage.session.get(["debugEvents"]);
  const events = current.debugEvents || [];
  events.push({
    ts: new Date().toISOString(),
    level,
    message,
    meta
  });
  await chrome.storage.session.set({ debugEvents: events.slice(-100) });
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
