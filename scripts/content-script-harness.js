"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const XhsExtractors = require("../extension/xhs-extractors");

class FakeElement {
  constructor({ text = "", attrs = {}, children = {}, parent = null } = {}) {
    this.textContent = text;
    this.attrs = attrs;
    this.children = children;
    this.parent = parent;
    this.currentSrc = attrs.currentSrc || "";
    this.src = attrs.src || "";
    this.className = attrs.className || "";
    this.alt = attrs.alt || "";
  }

  getAttribute(name) {
    return this.attrs[name] || "";
  }

  closest() {
    return this.parent || this;
  }

  querySelector(selector) {
    if (selector.includes("img")) return this.children.img || null;
    if (selector.includes("title") || selector.includes("span") || selector.includes("div")) return this.children.title || null;
    if (selector.includes("author") || selector.includes("name")) return this.children.author || null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector.includes("img")) return this.children.images || [];
    if (selector.includes("video")) return this.children.videos || [];
    if (selector.includes("desc") || selector.includes("content") || selector.includes("note-text")) return this.children.textNodes || [];
    return [];
  }
}

function makeCard(id) {
  const root = new FakeElement({
    children: {
      img: new FakeElement({ attrs: { src: `https://img.example/${id}.jpg`, currentSrc: `https://img.example/${id}.jpg` } }),
      title: new FakeElement({ text: `标题 ${id}` }),
      author: new FakeElement({ text: `作者 ${id}` })
    }
  });
  return new FakeElement({
    text: `标题 ${id}`,
    attrs: { href: `/explore/${id}?xsec_token=token-${id}`, title: `标题 ${id}` },
    parent: root
  });
}

function makeDataCard(id) {
  const root = new FakeElement({
    text: `数据卡 ${id}`,
    children: {
      img: new FakeElement({ attrs: { src: `https://img.example/${id}.jpg` } }),
      title: new FakeElement({ text: `数据卡 ${id}` }),
      author: new FakeElement({ text: `作者 ${id}` })
    }
  });
  return new FakeElement({
    text: `数据卡 ${id}`,
    attrs: { "data-note-id": id },
    parent: root
  });
}

function createHarness() {
  const messages = [];
  const effectiveBridgeControls = [];
  const listeners = {};
  const mutationCallbacks = [];
  let bridgeLoaded = false;
  const document = {
    body: new FakeElement({ text: "" }),
    documentElement: new FakeElement(),
    head: new FakeElement(),
    visibilityState: "visible",
    readyState: "complete",
    cards: [makeCard("noteabc123")],
    dataCards: [],
    scripts: [],
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a") return this.cards;
      if (selector === "script") return this.scripts;
      if (selector.includes("data-note")) return this.dataCards;
      if (selector.includes("/explore/") || selector.includes("/discovery/item/")) return this.cards;
      return [];
    },
    createElement() {
      return { set src(value) { this._src = value; }, get src() { return this._src; }, remove() {}, onload: null };
    }
  };
  document.documentElement.appendChild = (node) => {
    setTimeout(() => {
      bridgeLoaded = true;
      if (typeof node.onload === "function") node.onload();
    }, 0);
  };

  const chrome = {
    runtime: {
      getURL: (file) => file,
      sendMessage(payload) {
        messages.push(payload);
        return Promise.resolve({ ok: true });
      },
      onMessage: {
        addListener(callback) {
          listeners.message = callback;
        }
      }
    }
  };

  class FakeMutationObserver {
    constructor(callback) {
      mutationCallbacks.push(callback);
    }
    observe() {}
  }

  const context = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    MutationObserver: FakeMutationObserver,
    document,
    location: {
      href: "https://www.xiaohongshu.com/user/profile/account?tab=fav&subTab=note",
      hostname: "www.xiaohongshu.com",
      pathname: "/user/profile/account"
    },
    chrome,
    XhsExtractors,
    window: {
      addEventListener(type, callback) {
        listeners[type] = callback;
      },
      clearTimeout,
      setTimeout,
      scrollY: 0,
      innerHeight: 800,
      scrollBy() {},
      postMessage(payload) {
        messages.push(payload);
        if (bridgeLoaded && payload.source === "xhs-local-archive-control") effectiveBridgeControls.push(payload);
      }
    }
  };
  context.globalThis = context;
  context.window.window = context.window;
  context.window.document = document;
  context.window.chrome = chrome;
  context.window.XhsExtractors = XhsExtractors;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "content-script.js"), "utf8"), context, {
    filename: "content-script.js"
  });

  function sendToContent(payload) {
    return new Promise((resolve) => {
      listeners.message(payload, {}, resolve);
    });
  }

  return { context, document, messages, listeners, mutationCallbacks, effectiveBridgeControls, sendToContent };
}

async function main() {
  const harness = createHarness();
  const captured = await harness.sendToContent({ type: "captureNow" });
  assert.equal(captured.ok, true);
  assert.equal(captured.count, 1);
  assert.equal(captured.candidateCount, 1);
  assert.equal(captured.pageType, "profile-favorites");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.effectiveBridgeControls.some((message) => message.active === true), true);
  const discovered = harness.messages.find((message) => message.type === "notesDiscovered");
  assert.equal(discovered.notes[0].noteId, "noteabc123");
  assert.equal(discovered.notes[0].xsecToken, "token-noteabc123");

  const diagnostics = await harness.sendToContent({ type: "diagnosePage" });
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.diagnostics.pageType, "profile-favorites");
  assert.equal(diagnostics.diagnostics.candidateCount, 1);

  harness.document.cards = [];
  harness.document.dataCards = [makeDataCard("datanote123")];
  harness.document.scripts = [new FakeElement({
    text: JSON.stringify({ data: { items: [{ note_card: { note_id: "jsonnote123", display_title: "JSON 笔记", image_list: [{ url: "https://img.example/json.jpg" }] } }] } })
  })];
  const capturedFromFallbacks = await harness.sendToContent({ type: "captureNow" });
  assert.equal(capturedFromFallbacks.ok, true);
  assert.equal(capturedFromFallbacks.candidateCount, 1);
  assert.equal(capturedFromFallbacks.count, 2);

  const commentPayload = {
    data: {
      comments: [{ user: { nickname: "用户A" }, content: "评论内容", like_count: 3 }]
    }
  };
  const beforeCommentMessages = harness.messages.filter((message) => message.type === "notesDiscovered").length;
  harness.listeners.message({
    source: "xhs-local-archive",
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/comment/page",
    body: JSON.stringify(commentPayload)
  });
  assert.equal(harness.messages.filter((message) => message.type === "notesDiscovered").length, beforeCommentMessages);

  harness.document.body.textContent = "请完成验证码验证";
  harness.mutationCallbacks[0]();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopped = harness.messages.find((message) => message.type === "scanStatus" && message.reason === "verification_or_login_required");
  assert.equal(Boolean(stopped), true);
  const disabledBridge = harness.messages.find((message) => message.source === "xhs-local-archive-control" && message.active === false);
  assert.equal(Boolean(disabledBridge), true);

  console.log(JSON.stringify({
    ok: true,
    checks: ["captureNow", "profileFavoritesDiagnostics", "fallbackCardExtraction", "embeddedJsonExtraction", "bridgeEnabledAfterLoad", "commentOnlyIgnored", "dynamicRiskStop", "bridgeDisabledOnRisk"]
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
