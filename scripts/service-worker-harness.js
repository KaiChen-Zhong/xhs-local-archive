"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness({ localNotes = [], nativeHandler = null } = {}) {
  const session = {};
  const createdTabs = [];
  const sentToTabs = [];
  const nativeCalls = [];
  const listeners = {};
  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: { addListener(callback) { listeners.installed = callback; } },
      onMessage: { addListener(callback) { listeners.message = callback; } },
      connectNative() {
        if (!nativeHandler) throw new Error("native not available in harness");
        const messageListeners = [];
        const disconnectListeners = [];
        return {
          onMessage: { addListener(callback) { messageListeners.push(callback); } },
          onDisconnect: { addListener(callback) { disconnectListeners.push(callback); } },
          postMessage(payload) {
            nativeCalls.push(payload);
            setTimeout(async () => {
              try {
                const response = await nativeHandler(payload);
                for (const callback of messageListeners) callback(response);
              } catch (error) {
                chrome.runtime.lastError = { message: error.message };
                for (const callback of disconnectListeners) callback();
                chrome.runtime.lastError = null;
              }
            }, 0);
          },
          disconnect() {}
        };
      }
    },
    sidePanel: {
      setPanelBehavior() {
        return Promise.resolve();
      }
    },
    storage: {
      session: {
        async get(keys) {
          if (!keys) return { ...session };
          const result = {};
          for (const key of keys) result[key] = session[key];
          return result;
        },
        async set(values) {
          Object.assign(session, values);
        }
      }
    },
    tabs: {
      async query() {
        return [{ id: 101, url: "https://www.xiaohongshu.com/explore" }];
      },
      async sendMessage(tabId, payload) {
        sentToTabs.push({ tabId, payload });
        if (payload.type === "captureNow") {
          return { ok: false, count: 0, reason: "verification_or_login_required" };
        }
        return { ok: true };
      },
      async create(options) {
        const tab = { id: 200 + createdTabs.length, ...options };
        createdTabs.push(tab);
        return tab;
      }
    }
  };

  const context = {
    console,
    chrome,
    indexedDB: createFakeIndexedDb(localNotes),
    URL,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "service-worker.js"), "utf8"), context, {
    filename: "service-worker.js"
  });

  function sendRuntimeMessage(payload, sender = {}) {
    return new Promise((resolve) => {
      listeners.message(payload, sender, resolve);
    });
  }

  return { session, createdTabs, sentToTabs, nativeCalls, sendRuntimeMessage };
}

function createFakeIndexedDb(localNotes) {
  const records = new Map((localNotes || []).map((note) => [note.noteId, { ...note }]));
  const asyncRequest = (valueGetter, apply = null, done = null) => {
    const request = {};
    setTimeout(() => {
      try {
        if (apply) apply();
        request.result = typeof valueGetter === "function" ? valueGetter() : valueGetter;
        if (typeof request.onsuccess === "function") request.onsuccess();
        if (done) done();
      } catch (error) {
        request.error = error;
        if (typeof request.onerror === "function") request.onerror();
        if (done) done();
      }
    }, 0);
    return request;
  };
  return {
    open() {
      const request = {};
      setTimeout(() => {
        request.result = {
          transaction() {
            const tx = {
              oncomplete: null,
              onerror: null,
              finish() {
                setTimeout(() => {
                  if (typeof tx.oncomplete === "function") tx.oncomplete();
                }, 0);
              },
              objectStore() {
                return {
                  getAll() {
                    return asyncRequest(() => Array.from(records.values()).map((note) => ({ ...note })), null, tx.finish);
                  },
                  get(noteId) {
                    return asyncRequest(() => records.get(noteId) || null, null, tx.finish);
                  },
                  put(note) {
                    if (note && note.noteId) records.set(note.noteId, { ...note });
                    tx.finish();
                  },
                  delete(noteId) {
                    records.delete(noteId);
                    tx.finish();
                  },
                  clear() {
                    records.clear();
                    tx.finish();
                  }
                };
              }
            };
            return tx;
          },
          close() {}
        };
        if (typeof request.onsuccess === "function") request.onsuccess();
      }, 0);
      return request;
    }
  };
}

async function main() {
  const harness = createHarness({
    localNotes: [{
      noteId: "known-note-1",
      title: "已收录帖子",
      author: "作者A",
      url: "https://www.xiaohongshu.com/explore/known-note-1?xsec_token=known-token",
      cover: "https://img.example/known-note-1.jpg",
      xsecToken: "known-token",
      discoveryIndex: 7,
      statuses: { discovered: true, visualOrdered: true }
    }]
  });

  const capture = await harness.sendRuntimeMessage({ type: "captureNow" });
  assert.equal(capture.ok, false);
  assert.equal(capture.reason, "verification_or_login_required");
  assert.equal(harness.sentToTabs.length, 1);
  assert.equal(harness.sentToTabs[0].payload.options.knownNotes[0].noteId, "known-note-1");
  assert.equal(harness.sentToTabs[0].payload.options.knownNotes[0].statuses.seededLocal, true);
  assert.equal(harness.session.riskLockReason, "verification_or_login_required");
  assert.ok(Number(harness.session.riskLockUntil) > Date.now());

  const blockedCapture = await harness.sendRuntimeMessage({ type: "captureNow" });
  assert.equal(blockedCapture.ok, false);
  assert.equal(blockedCapture.error, "risk_lock_active");
  assert.equal(harness.sentToTabs.length, 1);

  harness.session.riskLockUntil = Date.now() - 1;
  const unblockedCapture = await harness.sendRuntimeMessage({ type: "captureNow" });
  assert.equal(unblockedCapture.ok, false);
  assert.equal(unblockedCapture.reason, "verification_or_login_required");

  const nativeNotes = new Map();
  const autoArchiveHarness = createHarness({
    nativeHandler(payload) {
      if (payload.type === "upsertNotes") {
        for (const note of payload.notes || []) nativeNotes.set(note.noteId, { ...note });
        return { ok: true, upserted: Array.from(nativeNotes.keys()) };
      }
      if (payload.type === "listNotes") {
        return { ok: true, notes: Array.from(nativeNotes.values()) };
      }
      if (payload.type === "archiveNote") {
        const note = nativeNotes.get(payload.noteId);
        const archived = { ...note, markdownPath: `C:\\archive\\${payload.noteId}.md` };
        nativeNotes.set(payload.noteId, archived);
        return { ok: true, note: archived };
      }
      if (payload.type === "logDiagnostic") return { ok: true };
      return { ok: false, error: `unexpected:${payload.type}` };
    }
  });
  const discovered = await autoArchiveHarness.sendRuntimeMessage({
    type: "notesDiscovered",
    notes: [{
      noteId: "auto-archive-1",
      title: "自动归档",
      url: "https://www.xiaohongshu.com/explore/auto-archive-1",
      cover: "https://img.example/auto-archive-1.jpg"
    }]
  });
  assert.equal(discovered.ok, true);
  await waitFor(() => autoArchiveHarness.nativeCalls.some((payload) => payload.type === "archiveNote" && payload.noteId === "auto-archive-1"), 1000);
  await waitFor(() => autoArchiveHarness.session.backgroundJobStatus && autoArchiveHarness.session.backgroundJobStatus.status === "idle", 1000);
  assert.equal(autoArchiveHarness.session.backgroundJobStatus.succeeded, 1);
  const listed = await autoArchiveHarness.sendRuntimeMessage({ type: "listNotes" });
  assert.equal(listed.notes[0].markdownPath, "C:\\archive\\auto-archive-1.md");

  console.log(JSON.stringify({
    ok: true,
    checks: ["captureSeedsKnownLocalNotes", "riskLockFromCapture", "riskLockBlocksCapture", "riskLockExpires", "autoArchiveAfterDiscovery"]
  }, null, 2));
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timeout");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
