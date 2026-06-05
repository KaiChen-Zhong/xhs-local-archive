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
    this.dispatchedEvents = [];
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
    if (selector.includes("href") || selector.includes("data-note")) return this.children.anchors || [];
    if (selector.includes("img") || selector.includes("srcset") || selector.includes("data-src")) return this.children.images || (this.children.img ? [this.children.img] : []);
    if (selector.includes("video")) return this.children.videos || [];
    if (selector.includes("desc") || selector.includes("content") || selector.includes("note-text")) return this.children.textNodes || [];
    if (selector === "*") return Object.values(this.children).flat().filter(Boolean);
    return [];
  }

  getBoundingClientRect() {
    return this.rect || { top: 0, left: 0, width: 120, height: 160 };
  }

  dispatchEvent(event) {
    this.dispatchedEvents.push(event && event.type || "");
    return true;
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

function makeSectionCard(id, rect = null) {
  const root = new FakeElement({
    text: `区块卡 ${id}`,
    attrs: { rect },
    children: {
      img: new FakeElement({ attrs: { src: `https://img.example/${id}.jpg`, currentSrc: `https://img.example/${id}.jpg` } }),
      title: new FakeElement({ text: `区块卡 ${id}` }),
      author: new FakeElement({ text: `作者 ${id}` })
    }
  });
  const explore = new FakeElement({
    attrs: { href: `/explore/${id}`, rect },
    parent: root
  });
  const profile = new FakeElement({
    attrs: { href: `/user/profile/account/${id}?xsec_token=token-${id}`, title: `区块卡 ${id}`, rect },
    parent: root
  });
  root.children.anchors = [explore, profile];
  return root;
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
    sections: [],
    dataCards: [],
    scrollContainers: [],
    scripts: [],
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a") return this.cards;
      if (selector === "section") return this.sections;
      if (selector === "script") return this.scripts;
      if (selector.includes("data-note")) return this.dataCards;
      if (selector === "main, section, div") return this.scrollContainers;
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
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    WheelEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.deltaY = init.deltaY || 0;
      }
    },
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
      if (type === "message") listeners.windowMessage = callback;
      else listeners[type] = callback;
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

  function sendWindowMessage(data) {
    if (listeners.windowMessage) listeners.windowMessage({ source: context.window, data });
  }

  return { context, document, messages, listeners, mutationCallbacks, effectiveBridgeControls, sendToContent, sendWindowMessage };
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

  const supplementalHarness = createHarness();
  const supplementalCapture = await supplementalHarness.sendToContent({
    type: "captureNow",
    options: {
      knownNotes: [{
        noteId: "noteabc123",
        title: "标题 noteabc123",
        author: "作者 noteabc123",
        url: "https://www.xiaohongshu.com/explore/noteabc123?xsec_token=token-noteabc123",
        cover: "https://img.example/noteabc123.jpg",
        xsecToken: "token-noteabc123",
        discoveryIndex: 0,
        source: "manual",
        statuses: { discovered: true, visualOrdered: true }
      }]
    }
  });
  assert.equal(supplementalCapture.ok, true);
  assert.equal(supplementalCapture.count, 0);

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

  const provisionalOrderHarness = createHarness();
  provisionalOrderHarness.document.cards = [];
  const networkEnabled = await provisionalOrderHarness.sendToContent({ type: "enableNetworkCapture" });
  assert.equal(networkEnabled.ok, true);
  provisionalOrderHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 1,
    url: "https://edith.xiaohongshu.com/api/sns/web/v1/note/user/posted",
    body: JSON.stringify({
      data: {
        items: [
          { note_card: { note_id: "vislower123", display_title: "下方卡", image_list: [{ url: "https://img.example/lower.jpg" }] } },
          { note_card: { note_id: "visupper123", display_title: "上方卡", image_list: [{ url: "https://img.example/upper.jpg" }] } }
        ]
      }
    })
  });
  provisionalOrderHarness.document.cards = [
    makeCard("vislower123", { top: 420, left: 20, width: 120, height: 160 }),
    makeCard("visupper123", { top: 120, left: 20, width: 120, height: 160 })
  ];
  const visualOverride = await provisionalOrderHarness.sendToContent({ type: "captureNow" });
  assert.equal(visualOverride.ok, true);
  const visualMessages = provisionalOrderHarness.messages.filter((message) => message.type === "notesDiscovered");
  const visualOrdered = visualMessages[visualMessages.length - 1];
  assert.deepEqual(Array.from(visualOrdered.notes, (note) => note.noteId), ["visupper123", "vislower123"]);
  assert.equal(visualOrdered.notes[0].discoveryIndex > visualOrdered.notes[1].discoveryIndex, true);
  assert.equal(visualOrdered.notes.every((note) => note.statuses.visualOrdered && note.statuses.apiOrdered), true);

  const requestOrderHarness = createHarness();
  requestOrderHarness.document.cards = [];
  assert.equal((await requestOrderHarness.sendToContent({ type: "enableNetworkCapture" })).ok, true);
  requestOrderHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 2,
    url: "https://edith.xiaohongshu.com/api/sns/web/v1/note/user/posted",
    body: JSON.stringify({ data: { items: [{ note_card: { note_id: "requestsecond123", display_title: "第二页", image_list: [{ url: "https://img.example/second.jpg" }] } }] } })
  });
  requestOrderHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 1,
    url: "https://edith.xiaohongshu.com/api/sns/web/v1/note/user/posted",
    body: JSON.stringify({ data: { items: [{ note_card: { note_id: "requestfirst123", display_title: "第一页", image_list: [{ url: "https://img.example/first.jpg" }] } }] } })
  });
  const requestNotes = requestOrderHarness.messages
    .filter((message) => message.type === "notesDiscovered")
    .flatMap((message) => message.notes);
  const requestFirst = requestNotes.find((note) => note.noteId === "requestfirst123");
  const requestSecond = requestNotes.find((note) => note.noteId === "requestsecond123");
  assert.equal(requestFirst.discoveryIndex < requestSecond.discoveryIndex, true);

  const cursorHarness = createHarness();
  cursorHarness.document.cards = [];
  assert.equal((await cursorHarness.sendToContent({ type: "enableNetworkCapture" })).ok, true);
  cursorHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 1,
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30&cursor=cursoranchor123",
    body: JSON.stringify({
      data: {
        notes: [
          { note_id: "cursorchilda123", display_title: "锚点后一", cover: { url_default: "https://img.example/child-a.jpg" }, xsec_token: "token-child-a" },
          { note_id: "cursorchildb123", display_title: "锚点后二", cover: { url_default: "https://img.example/child-b.jpg" }, xsec_token: "token-child-b" }
        ],
        cursor: "cursorchildb123"
      }
    })
  });
  cursorHarness.document.sections = [
    makeSectionCard("sectionfirst123", { top: 300, left: 500, width: 120, height: 160 }),
    makeSectionCard("sectionsecond123", { top: 120, left: 20, width: 120, height: 160 }),
    makeSectionCard("cursoranchor123", { top: 180, left: 800, width: 120, height: 160 })
  ];
  const cursorCapture = await cursorHarness.sendToContent({ type: "captureNow" });
  assert.equal(cursorCapture.ok, true);
  const latestCursorNotes = latestNotesById(cursorHarness.messages);
  assert.deepEqual([
    latestCursorNotes.get("sectionfirst123").discoveryIndex,
    latestCursorNotes.get("sectionsecond123").discoveryIndex,
    latestCursorNotes.get("cursoranchor123").discoveryIndex,
    latestCursorNotes.get("cursorchilda123").discoveryIndex,
    latestCursorNotes.get("cursorchildb123").discoveryIndex
  ], [0, 1, 2, 3, 4]);
  assert.equal(latestCursorNotes.get("cursorchilda123").statuses.collectionOrdered, true);

  const rootAfterChildHarness = createHarness();
  rootAfterChildHarness.document.cards = [];
  assert.equal((await rootAfterChildHarness.sendToContent({ type: "enableNetworkCapture" })).ok, true);
  rootAfterChildHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 2,
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30&cursor=rootc123",
    body: JSON.stringify({ data: { notes: [
      { note_id: "rootd123", display_title: "第四", cover: { url_default: "https://img.example/d.jpg" } },
      { note_id: "roote123", display_title: "第五", cover: { url_default: "https://img.example/e.jpg" } }
    ], cursor: "roote123" } })
  });
  rootAfterChildHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 1,
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30",
    body: JSON.stringify({ data: { notes: [
      { note_id: "roota123", display_title: "第一", cover: { url_default: "https://img.example/a.jpg" } },
      { note_id: "rootb123", display_title: "第二", cover: { url_default: "https://img.example/b.jpg" } },
      { note_id: "rootc123", display_title: "第三", cover: { url_default: "https://img.example/c.jpg" } }
    ], cursor: "rootc123" } })
  });
  const rootLatest = latestNotesById(rootAfterChildHarness.messages);
  assert.deepEqual(["roota123", "rootb123", "rootc123", "rootd123", "roote123"].map((id) => rootLatest.get(id).discoveryIndex), [0, 1, 2, 3, 4]);

  const overlapHarness = createHarness();
  overlapHarness.document.cards = [];
  assert.equal((await overlapHarness.sendToContent({ type: "enableNetworkCapture" })).ok, true);
  overlapHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 1,
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30",
    body: JSON.stringify({ data: { notes: [
      { note_id: "overlapa123", display_title: "A", cover: { url_default: "https://img.example/a.jpg" } },
      { note_id: "overlapb123", display_title: "B", cover: { url_default: "https://img.example/b.jpg" } },
      { note_id: "overlapc123", display_title: "C", cover: { url_default: "https://img.example/c.jpg" } }
    ], cursor: "overlapc123" } })
  });
  overlapHarness.sendWindowMessage({
    source: "xhs-local-archive",
    requestSeq: 2,
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30&cursor=overlapb123",
    body: JSON.stringify({ data: { notes: [
      { note_id: "overlapc123", display_title: "C", cover: { url_default: "https://img.example/c.jpg" } },
      { note_id: "overlapd123", display_title: "D", cover: { url_default: "https://img.example/d.jpg" } }
    ], cursor: "overlapd123" } })
  });
  const overlapLatest = latestNotesById(overlapHarness.messages);
  assert.deepEqual(["overlapa123", "overlapb123", "overlapc123", "overlapd123"].map((id) => overlapLatest.get(id).discoveryIndex), [0, 1, 2, 3]);

  const innerScrollHarness = createHarness();
  innerScrollHarness.document.body.textContent = "笔记・999";
  const innerScroller = new FakeElement({ attrs: { className: "feeds-container" } });
  innerScroller.scrollHeight = 5000;
  innerScroller.clientHeight = 800;
  innerScroller.scrollTop = 0;
  innerScrollHarness.document.scrollContainers = [innerScroller];
  const innerStarted = await innerScrollHarness.sendToContent({ type: "startScan" });
  assert.equal(innerStarted.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(innerScroller.scrollTop > 0, true);
  assert.equal(innerScroller.dispatchedEvents.includes("wheel"), true);
  const innerStatus = innerScrollHarness.messages.find((message) => message.type === "scanStatus" && message.status === "running");
  assert.equal(innerStatus.scrollTarget, "element.feeds-container");
  await innerScrollHarness.sendToContent({ type: "stopScan" });

  const sideBarHarness = createHarness();
  sideBarHarness.document.body.textContent = "笔记・999";
  const sideBar = new FakeElement({ attrs: { className: "side-bar side-bar-ai" } });
  sideBar.scrollHeight = 20000;
  sideBar.clientHeight = 800;
  sideBar.scrollTop = 0;
  const feedScroller = new FakeElement({
    attrs: { className: "feeds-container" },
    children: { anchors: [makeCard("feedscroll123")] }
  });
  feedScroller.scrollHeight = 5000;
  feedScroller.clientHeight = 800;
  feedScroller.scrollTop = 0;
  sideBarHarness.document.scrollContainers = [sideBar, feedScroller];
  const sideBarStarted = await sideBarHarness.sendToContent({ type: "startScan" });
  assert.equal(sideBarStarted.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const sideBarStatus = sideBarHarness.messages.find((message) => message.type === "scanStatus" && message.status === "running");
  assert.notEqual(sideBarStatus.scrollTarget, "element.side-bar.side-bar-ai");
  assert.equal(sideBarStatus.scrollTarget, "element.feeds-container");
  await sideBarHarness.sendToContent({ type: "stopScan" });

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
  const startedScan = await scanHarness.sendToContent({
    type: "startScan",
    options: {
      knownNotes: [
        { noteId: "seeded-1", title: "已收录1", url: "https://www.xiaohongshu.com/explore/seeded-1", cover: "https://img.example/seeded-1.jpg", statuses: { discovered: true, visualOrdered: true }, discoveryIndex: 0 },
        { noteId: "seeded-2", title: "已收录2", url: "https://www.xiaohongshu.com/explore/seeded-2", cover: "https://img.example/seeded-2.jpg", statuses: { discovered: true, visualOrdered: true }, discoveryIndex: 1 }
      ]
    }
  });
  assert.equal(startedScan.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const scanStatus = scanHarness.messages.find((message) => message.type === "scanStatus" && message.status === "running");
  assert.equal(scanStatus.expectedTotal, 13224);
  assert.equal(scanStatus.knownCount >= 2, true);
  assert.equal(scanStatus.missingCover, 0);
  await scanHarness.sendToContent({ type: "stopScan" });

  const incompleteHarness = createHarness();
  incompleteHarness.document.body.textContent = "笔记・13224";
  incompleteHarness.context.window.innerHeight = 800;
  incompleteHarness.context.document.documentElement.scrollHeight = 800;
  incompleteHarness.context.window.scrollBy = () => {};
  incompleteHarness.context.window.setTimeout = (callback) => setTimeout(callback, 0);
  const incompleteStarted = await incompleteHarness.sendToContent({
    type: "startScan",
    options: { waitMs: 900, stableRoundsToFinish: 6, maxNewNotes: 20000 }
  });
  assert.equal(incompleteStarted.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(Boolean(incompleteHarness.messages.find((message) => message.type === "scanStatus" && message.status === "stopped")), false);
  await incompleteHarness.sendToContent({ type: "stopScan" });

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
    checks: ["captureNow", "supplementalCaptureSkipsKnown", "visualDiscoveryOrder", "apiCollectionOrderOverride", "networkRequestOrder", "collectionCursorAnchors", "collectionRootOutOfOrder", "collectionOverlapDedupe", "innerScrollContainer", "avoidSidebarScrollTarget", "profileTokenUrlPreferred", "lazyCoverExtraction", "scanCoverageDiagnostics", "scanSeedsKnownLocalNotes", "incompleteDoesNotAutoStop", "profileFavoritesDiagnostics", "fallbackCardExtraction", "embeddedJsonExtraction", "bridgeEnabledAfterLoad", "commentOnlyIgnored", "dynamicRiskStop", "bridgeDisabledOnRisk"]
  }, null, 2));
}

function latestNotesById(messages) {
  const latest = new Map();
  for (const message of messages) {
    if (message.type !== "notesDiscovered") continue;
    for (const note of message.notes || []) latest.set(note.noteId, note);
  }
  return latest;
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
