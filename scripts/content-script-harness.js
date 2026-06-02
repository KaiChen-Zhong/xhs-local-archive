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
    this.srcset = attrs.srcset || "";
    this.className = attrs.className || "";
    this.alt = attrs.alt || "";
    this.rect = attrs.rect || null;
    this.style = attrs.style || {};
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
    if (selector.includes("img") || selector.includes("srcset") || selector.includes("data-src")) return this.children.images || (this.children.img ? [this.children.img] : []);
    if (selector.includes("video")) return this.children.videos || [];
    if (selector.includes("desc") || selector.includes("content") || selector.includes("note-text")) return this.children.textNodes || [];
    if (selector === "*") return Object.values(this.children).flat().filter(Boolean);
    return [];
  }

  getBoundingClientRect() {
    return this.rect || { top: 0, left: 0, width: 120, height: 160 };
  }
}

function makeCard(id, rect = null) {
  const root = new FakeElement({
    attrs: { rect },
    children: {
      img: new FakeElement({ attrs: { src: `https://img.example/${id}.jpg`, currentSrc: `https://img.example/${id}.jpg` } }),
      title: new FakeElement({ text: `标题 ${id}` }),
      author: new FakeElement({ text: `作者 ${id}` })
    }
  });
  return new FakeElement({
    text: `标题 ${id}`,
    attrs: { href: `/explore/${id}?xsec_token=token-${id}`, title: `标题 ${id}`, rect },
    parent: root
  });
}

function makeXhsProfileCard(id) {
  const image = new FakeElement({ attrs: { src: `https://img.example/${id}.jpg`, currentSrc: `https://img.example/${id}.jpg` } });
  const root = new FakeElement({
    text: `真实卡 ${id}`,
    attrs: { rect: { top: 120, left: 40, width: 274, height: 430 } },
    children: {
      img: image,
      title: new FakeElement({ text: `真实卡 ${id}` }),
      author: new FakeElement({ text: `作者 ${id}` })
    }
  });
  const hiddenExplore = new FakeElement({
    attrs: {
      href: `/explore/${id}`,
      rect: { top: 0, left: 0, width: 0, height: 0 }
    },
    parent: root
  });
  const visibleProfile = new FakeElement({
    attrs: {
      href: `/user/profile/self/${id}?xsec_token=token-${id}&xsec_source=pc_collect`,
      title: `真实卡 ${id}`,
      rect: { top: 120, left: 40, width: 274, height: 360 }
    },
    parent: root
  });
  root.children.anchors = [hiddenExplore, visibleProfile];
  return { hiddenExplore, visibleProfile };
}

function makeLazyImageCard(id) {
  const root = new FakeElement({
    text: `懒加载 ${id}`,
    children: {
      img: new FakeElement({ attrs: { "data-src": `https://img.example/${id}-lazy.jpg` } }),
      title: new FakeElement({ text: `懒加载 ${id}` })
    }
  });
  return new FakeElement({
    text: `懒加载 ${id}`,
    attrs: { href: `/user/profile/self/${id}?xsec_token=token-${id}` },
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

  const orderHarness = createHarness();
  orderHarness.document.cards = [
    makeCard("lowernote123", { top: 420, left: 20, width: 120, height: 160 }),
    makeCard("uppernote123", { top: 120, left: 20, width: 120, height: 160 })
  ];
  const orderedCapture = await orderHarness.sendToContent({ type: "captureNow" });
  assert.equal(orderedCapture.ok, true);
  const ordered = orderHarness.messages.find((message) => message.type === "notesDiscovered");
  assert.deepEqual(Array.from(ordered.notes, (note) => note.noteId), ["uppernote123", "lowernote123"]);
  assert.deepEqual(Array.from(ordered.notes, (note) => note.discoveryIndex), [0, 1]);

  const profileHarness = createHarness();
  const profileCard = makeXhsProfileCard("profiletoken123");
  profileHarness.document.cards = [profileCard.hiddenExplore, profileCard.visibleProfile];
  const profileCapture = await profileHarness.sendToContent({ type: "captureNow" });
  assert.equal(profileCapture.ok, true);
  const profileDiscovered = profileHarness.messages.find((message) => message.type === "notesDiscovered");
  assert.equal(profileDiscovered.notes[0].noteId, "profiletoken123");
  assert.match(profileDiscovered.notes[0].url, /xsec_token=token-profiletoken123/);
  assert.equal(profileDiscovered.notes[0].xsecToken, "token-profiletoken123");

  const lazyHarness = createHarness();
  lazyHarness.document.cards = [makeLazyImageCard("lazycover123")];
  const lazyCapture = await lazyHarness.sendToContent({ type: "captureNow" });
  assert.equal(lazyCapture.ok, true);
  const lazyDiscovered = lazyHarness.messages.find((message) => message.type === "notesDiscovered");
  assert.equal(lazyDiscovered.notes[0].cover, "https://img.example/lazycover123-lazy.jpg");

  const diagnostics = await harness.sendToContent({ type: "diagnosePage" });
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.diagnostics.pageType, "profile-favorites");
  assert.equal(diagnostics.diagnostics.candidateCount, 1);

  const scanHarness = createHarness();
  scanHarness.document.body.textContent = "笔记・13224";
  const startedScan = await scanHarness.sendToContent({ type: "startScan" });
  assert.equal(startedScan.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const scanStatus = scanHarness.messages.find((message) => message.type === "scanStatus" && message.status === "running");
  assert.equal(scanStatus.expectedTotal, 13224);
  assert.equal(scanStatus.missingCover, 0);
  await scanHarness.sendToContent({ type: "stopScan" });

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
    checks: ["captureNow", "visualDiscoveryOrder", "profileTokenUrlPreferred", "lazyCoverExtraction", "scanCoverageDiagnostics", "profileFavoritesDiagnostics", "fallbackCardExtraction", "embeddedJsonExtraction", "bridgeEnabledAfterLoad", "commentOnlyIgnored", "dynamicRiskStop", "bridgeDisabledOnRisk"]
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
