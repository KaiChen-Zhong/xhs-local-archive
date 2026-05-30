"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness() {
  const session = {};
  const createdTabs = [];
  const sentToTabs = [];
  const listeners = {};
  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: { addListener(callback) { listeners.installed = callback; } },
      onMessage: { addListener(callback) { listeners.message = callback; } },
      connectNative() {
        throw new Error("native not available in harness");
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
    indexedDB: {},
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

  return { session, createdTabs, sentToTabs, sendRuntimeMessage };
}

async function main() {
  const harness = createHarness();

  const capture = await harness.sendRuntimeMessage({ type: "captureNow" });
  assert.equal(capture.ok, false);
  assert.equal(capture.reason, "verification_or_login_required");
  assert.equal(harness.sentToTabs.length, 1);
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

  console.log(JSON.stringify({
    ok: true,
    checks: ["riskLockFromCapture", "riskLockBlocksCapture", "riskLockExpires"]
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
