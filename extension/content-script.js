(function () {
  "use strict";

  const STATE = {
    scanActive: false,
    observer: null,
    known: new Map(),
    scanTimer: null,
    lastNewAt: 0,
    stableRounds: 0,
    phase: "down-1",
    newNotesThisScan: 0,
    lastKnownCount: 0,
    lastScrollHeight: 0,
    discoverySeq: 0,
    bridgeInjected: false,
    collectionEnabled: false,
    collectionMode: "idle"
  };

  const SCAN_DEFAULTS = {
    stepPx: 760,
    waitMs: 1200,
    stableRoundsToFinish: 10,
    maxMinutes: 360,
    maxNewNotes: 20000
  };

  startObserver();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!STATE.collectionEnabled) return;
    const data = event.data;
    if (!data || data.source !== "xhs-local-archive") return;
    parseNetworkPayload(data.url, data.body);
  });

  document.addEventListener("visibilitychange", () => {
    if (STATE.scanActive && document.visibilityState !== "visible") {
      stopControlledScan("page_hidden");
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "startScan") {
      sendResponse(startControlledScan(message.options || {}));
      return true;
    }
    if (message && message.type === "stopScan") {
      stopControlledScan("user_stopped");
      sendResponse({ ok: true });
      return true;
    }
    if (message && message.type === "captureNow") {
      const safetyStop = detectSafetyStop();
      if (safetyStop) {
        reportSafetyStop(safetyStop);
        sendResponse({ ok: false, count: 0, reason: safetyStop });
        return true;
      }
      const result = enableCollection("manual", true, "list");
      sendResponse({
        ok: true,
        count: result.notes.length,
        candidateCount: result.candidates,
        pageType: result.pageType,
        diagnostics: scanDiagnostics()
      });
      return true;
    }
    if (message && message.type === "resetCapturedState") {
      resetCaptureState();
      sendResponse({ ok: true });
      return true;
    }
    if (message && message.type === "diagnosePage") {
      sendResponse({ ok: true, diagnostics: pageDiagnostics() });
      return true;
    }
    if (message && message.type === "enableNetworkCapture") {
      const safetyStop = detectSafetyStop();
      if (safetyStop) {
        reportSafetyStop(safetyStop);
        sendResponse({ ok: false, reason: safetyStop });
        return true;
      }
      enableCollection("network", true, "list");
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  function injectBridgeAndEnable() {
    if (STATE.bridgeInjected) {
      setBridgeActive(true);
      return;
    }
    STATE.bridgeInjected = true;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.onload = () => {
      script.remove();
      if (STATE.collectionEnabled) setBridgeActive(true);
    };
    (document.documentElement || document.head).appendChild(script);
  }

  function enableCollection(source, withNetwork, mode) {
    STATE.collectionEnabled = true;
    STATE.collectionMode = mode || "list";
    if (withNetwork) {
      injectBridgeAndEnable();
    }
    const notes = [...captureVisibleCards(source), ...captureEmbeddedJsonNotes(source)];
    return { notes, candidates: visibleCardCandidates().length, pageType: pageType() };
  }

  function setBridgeActive(active) {
    window.postMessage({
      source: "xhs-local-archive-control",
      active: Boolean(active)
    }, "*");
  }

  function startObserver() {
    if (STATE.observer) return;
    STATE.observer = new MutationObserver(() => {
      if (!STATE.collectionEnabled) return;
      window.clearTimeout(STATE.captureDebounce);
      STATE.captureDebounce = window.setTimeout(() => {
        const safetyStop = detectSafetyStop();
        if (safetyStop) {
          reportSafetyStop(safetyStop);
          return;
        }
        captureVisibleCards("mutation");
      }, 250);
    });
    STATE.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function captureVisibleCards(source) {
    const cards = visibleCardCandidates();
    const changed = [];
    for (const anchor of cards) {
      const note = parseCard(anchor, source);
      const remembered = rememberNote(note);
      if (remembered) changed.push(remembered);
    }
    if (changed.length) {
      if (STATE.scanActive) STATE.newNotesThisScan += changed.filter((note) => note.statuses && note.statuses.firstSeenThisScan).length;
      STATE.lastNewAt = Date.now();
      STATE.stableRounds = 0;
      chrome.runtime.sendMessage({ type: "notesDiscovered", notes: changed.map(stripRuntimeFlags) }).catch(() => {});
    }
    return changed.map(stripRuntimeFlags);
  }

  function rememberNote(note) {
    if (!note || !note.noteId) return null;
    const existing = STATE.known.get(note.noteId);
    const incomingIsVisual = isVisualCardSource(note.source);
    const existingIsVisual = Boolean(existing && existing.statuses && existing.statuses.visualOrdered);
    const shouldUseIncomingOrder = !existing ||
      !Number.isFinite(existing.discoveryIndex) ||
      (incomingIsVisual && !existingIsVisual);
    const discoveryIndex = shouldUseIncomingOrder ? STATE.discoverySeq++ : existing.discoveryIndex;
    const merged = {
      ...(existing || {}),
      ...note,
      title: note.title || existing && existing.title || "",
      author: note.author || existing && existing.author || "",
      url: note.url || existing && existing.url || "",
      cover: note.cover || existing && existing.cover || "",
      xsecToken: note.xsecToken || existing && existing.xsecToken || "",
      discoveryIndex,
      statuses: {
        ...(existing && existing.statuses || {}),
        ...(note.statuses || {}),
        visualOrdered: existingIsVisual || incomingIsVisual,
        firstSeenThisScan: !existing
      }
    };
    const changed = !existing ||
      merged.title !== (existing.title || "") ||
      merged.cover !== (existing.cover || "") ||
      merged.url !== (existing.url || "") ||
      merged.xsecToken !== (existing.xsecToken || "") ||
      merged.author !== (existing.author || "") ||
      merged.discoveryIndex !== existing.discoveryIndex ||
      Boolean(merged.statuses.visualOrdered) !== existingIsVisual;
    if (!changed) return null;
    STATE.known.set(note.noteId, merged);
    return merged;
  }

  function isVisualCardSource(source) {
    return /^(manual|start-scan|controlled-scan|mutation|scan-stop)$/.test(String(source || ""));
  }

  function stripRuntimeFlags(note) {
    return {
      ...note,
      statuses: Object.fromEntries(Object.entries(note.statuses || {}).filter(([key]) => key !== "firstSeenThisScan"))
    };
  }

  function visibleCardCandidates() {
    const selectors = [
      "a[href*='/user/profile/']",
      "a[href*='/explore/']",
      "a[href*='/discovery/item/']",
      "[data-note-id]",
      "[data-noteid]",
      "[data-note_id]",
      "[data-url*='/user/profile/']",
      "[data-url*='/explore/']",
      "[data-url*='/discovery/item/']",
      "[data-href*='/user/profile/']",
      "[data-href*='/explore/']",
      "[data-href*='/discovery/item/']",
      "[onclick*='/user/profile/']",
      "[onclick*='/explore/']",
      "[onclick*='/discovery/item/']"
    ];
    return sortCardCandidates(Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).filter(hasCardUrl)))));
  }

  function sortCardCandidates(candidates) {
    return candidates
      .map((node, index) => ({ node, index, position: visualPosition(node) }))
      .sort((a, b) => {
        if (a.position.visible !== b.position.visible) return a.position.visible ? -1 : 1;
        if (a.position.top !== b.position.top) return a.position.top - b.position.top;
        if (a.position.left !== b.position.left) return a.position.left - b.position.left;
        return a.index - b.index;
      })
      .map((item) => item.node);
  }

  function visualPosition(node) {
    const target = node && typeof node.getBoundingClientRect === "function" ? node : node && node.closest && node.closest("section, article, div") || node;
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return { visible: false, top: Number.POSITIVE_INFINITY, left: Number.POSITIVE_INFINITY };
    }
    const rect = target.getBoundingClientRect();
    const top = Number(rect.top);
    const left = Number(rect.left);
    const width = Number(rect.width);
    const height = Number(rect.height);
    const hasBox = Number.isFinite(top) && Number.isFinite(left) && (width > 0 || height > 0);
    return {
      visible: hasBox,
      top: hasBox ? top + Number(window.scrollY || 0) : Number.POSITIVE_INFINITY,
      left: hasBox ? left : Number.POSITIVE_INFINITY
    };
  }

  function pageType() {
    const query = new URL(location.href).searchParams;
    if (/\/user\/profile\//.test(location.pathname || "") && query.get("tab") === "fav") return "profile-favorites";
    if (/\/user\/profile\//.test(location.pathname || "")) return "profile";
    return "other";
  }

  function parseCard(anchor, source) {
    const cardUrl = extractCardUrl(anchor);
    if (!cardUrl) return null;
    const url = new URL(cardUrl, location.href).toString();
    const noteId = extractNoteId(url);
    if (!noteId) return null;
    const root = cardRoot(anchor);
    const authorEl = root.querySelector("[class*='author'], [class*='name']");
    const title = bestTitle(root, anchor);
    return {
      noteId,
      url,
      title,
      author: textOf(authorEl),
      cover: bestImageUrl(root, anchor),
      xsecToken: new URL(url).searchParams.get("xsec_token") || "",
      source,
      statuses: { discovered: true },
      createdAt: new Date().toISOString()
    };
  }

  function bestImageUrl(root, anchor) {
    const urls = [];
    for (const node of [root, anchor].filter(Boolean)) {
      const images = Array.from(node.querySelectorAll && node.querySelectorAll("img, picture source, [srcset], [data-src], [data-original], [data-lazy]") || []);
      for (const image of images) {
        collectImageUrl(image.currentSrc, urls);
        collectImageUrl(image.src, urls);
        collectImageUrl(image.getAttribute && image.getAttribute("src"), urls);
        collectImageUrl(image.getAttribute && image.getAttribute("data-src"), urls);
        collectImageUrl(image.getAttribute && image.getAttribute("data-original"), urls);
        collectImageUrl(image.getAttribute && image.getAttribute("data-lazy"), urls);
        collectImageUrlFromSrcset(image.srcset || image.getAttribute && image.getAttribute("srcset"), urls);
      }
      const styled = Array.from(node.querySelectorAll && node.querySelectorAll("*") || []);
      for (const item of styled) collectImageUrlFromBackground(item.style && item.style.backgroundImage, urls);
    }
    return urls[0] || "";
  }

  function collectImageUrl(value, urls) {
    const text = String(value || "").trim();
    if (/^https?:\/\//.test(text)) urls.push(text);
  }

  function collectImageUrlFromSrcset(value, urls) {
    const first = String(value || "")
      .split(",")
      .map((item) => item.trim().split(/\s+/)[0])
      .find((item) => /^https?:\/\//.test(item));
    if (first) urls.push(first);
  }

  function collectImageUrlFromBackground(value, urls) {
    const match = String(value || "").match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
    if (match) urls.push(match[1]);
  }

  function cardRoot(anchor) {
    let node = anchor;
    for (let depth = 0; node && depth < 6; depth += 1) {
      const hasImage = Boolean(node.querySelector && node.querySelector("img"));
      const hasText = textOf(node).length > 0;
      const hasUrl = Boolean(extractCardUrl(node));
      if (hasImage && hasText && hasUrl) return node;
      node = node.parentElement;
    }
    return anchor.closest("section, article, div") || anchor;
  }

  function bestTitle(root, anchor) {
    const attrTitle = anchor.getAttribute("title") || anchor.getAttribute("aria-label") || "";
    const selectors = [
      "[class*='title']",
      "[class*='desc']",
      "[class*='content']",
      "figcaption",
      "h3",
      "h2",
      "p"
    ];
    for (const selector of selectors) {
      const value = textOf(root.querySelector(selector));
      if (looksLikeTitle(value)) return value.slice(0, 200);
    }
    if (looksLikeTitle(attrTitle)) return attrTitle.slice(0, 200);
    const text = textOf(anchor) || textOf(root);
    return text.split(/[｜|\n]/).map((item) => item.trim()).find(looksLikeTitle) || text.slice(0, 200);
  }

  function looksLikeTitle(value) {
    const text = String(value || "").trim();
    if (text.length < 2 || text.length > 220) return false;
    if (/^(赞|收藏|评论|分享|作者|关注|图片|视频)$/i.test(text)) return false;
    return true;
  }

  function captureEmbeddedJsonNotes(source) {
    const notes = [];
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const text = String(script.textContent || "");
      if (!/(note_id|noteId|note_card|noteCard|display_title|xsec_token|\/explore\/|\/discovery\/item\/)/.test(text)) continue;
      if (text.length > 3000000) continue;
      const payload = parseScriptJson(text);
      if (!payload) continue;
      notes.push(...globalThis.XhsExtractors.extractNotesFromJsonPayload(payload, `embedded:${source}`).map(cardOnlyNote));
    }
    const filtered = [];
    STATE.embeddedFingerprints = STATE.embeddedFingerprints || new Set();
    for (const note of notes) {
      const fingerprint = `${note.noteId}:${note.title || ""}:${note.cover || ""}`;
      if (STATE.embeddedFingerprints.has(fingerprint)) continue;
      STATE.embeddedFingerprints.add(fingerprint);
      const remembered = rememberNote(note);
      if (remembered) filtered.push(remembered);
    }
    if (filtered.length) {
      chrome.runtime.sendMessage({ type: "notesDiscovered", notes: filtered.map(stripRuntimeFlags) }).catch(() => {});
    }
    return filtered.map(stripRuntimeFlags);
  }

  function parseScriptJson(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    for (const candidate of scriptJsonCandidates(trimmed)) {
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    return null;
  }

  function scriptJsonCandidates(text) {
    const candidates = [];
    candidates.push(text);
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));
    const arrayStart = text.indexOf("[");
    const arrayEnd = text.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));
    return candidates;
  }

  function hasCardUrl(node) {
    return Boolean(extractCardUrl(node));
  }

  function extractCardUrl(node) {
    const attrs = ["href", "data-href", "data-url", "data-link", "data-share-url", "onclick"];
    for (const attr of attrs) {
      const value = node.getAttribute && node.getAttribute(attr);
      const url = extractUrlFromText(value);
      if (url) return url;
    }
    const noteId = pickAttr(node, ["data-note-id", "data-noteid", "data-note_id"]);
    if (/^[A-Za-z0-9]{8,}$/.test(noteId)) return `https://www.xiaohongshu.com/explore/${noteId}`;
    return extractUrlFromText(String(node.outerHTML || "").slice(0, 4000));
  }

  function extractUrlFromText(value) {
    const text = String(value || "");
    const absolute = text.match(/https:\/\/(?:www\.)?xiaohongshu\.com\/(?:(?:explore|discovery\/item)\/[A-Za-z0-9]|user\/profile\/[A-Za-z0-9_-]+\/[A-Za-z0-9])[^"' <>)\\]*/);
    if (absolute) return absolute[0];
    const relative = text.match(/\/(?:(?:explore|discovery\/item)\/[A-Za-z0-9]|user\/profile\/[A-Za-z0-9_-]+\/[A-Za-z0-9])[^"' <>)\\]*/);
    return relative ? relative[0] : "";
  }

  function pickAttr(node, names) {
    for (const name of names) {
      const value = node.getAttribute && node.getAttribute(name);
      if (value) return String(value).trim();
    }
    return "";
  }

  function pageDiagnostics() {
    const anchors = Array.from(document.querySelectorAll("a"));
    const candidates = visibleCardCandidates();
    return {
      url: location.href,
      pageType: pageType(),
      bodyWarning: detectAccessWarning(),
      visibilityState: document.visibilityState,
      collectionEnabled: STATE.collectionEnabled,
      bridgeInjected: STATE.bridgeInjected,
      candidateCount: candidates.length,
      anchorCount: anchors.length,
      noteLikeHrefSamples: anchors
        .map((anchor) => anchor.getAttribute("href") || "")
        .filter((href) => /\/explore\/|\/discovery\/item\/|\/user\/profile\/[A-Za-z0-9_-]+\/[A-Za-z0-9]/.test(href))
        .slice(0, 5),
      bodyTextSample: textOf(document.body).slice(0, 160)
    };
  }

  function parseNetworkPayload(url, body) {
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return;
    }
    if (/comment/i.test(url)) {
      return;
    }
    const notes = globalThis.XhsExtractors.extractNotesFromJsonPayload(json, url)
      .map(cardOnlyNote)
      .map(rememberNote)
      .filter(Boolean)
      .map(stripRuntimeFlags);
    if (notes.length) {
      if (STATE.scanActive) STATE.newNotesThisScan += notes.length;
      STATE.lastNewAt = Date.now();
      STATE.stableRounds = 0;
      chrome.runtime.sendMessage({ type: "notesDiscovered", notes }).catch(() => {});
    }
  }

  function cardOnlyNote(note) {
    return {
      noteId: note.noteId,
      url: note.url,
      title: note.title,
      author: note.author,
      cover: note.cover || (note.images || [])[0] || "",
      xsecToken: note.xsecToken,
      source: note.source,
      statuses: { discovered: true, cardOnly: true },
      createdAt: note.createdAt
    };
  }

  function startControlledScan(options) {
    if (STATE.scanActive) return { ok: true, started: false, reason: "already_running" };
    const safetyStop = detectSafetyStop();
    if (safetyStop) {
      reportSafetyStop(safetyStop);
      return { ok: false, started: false, reason: safetyStop };
    }
    resetCaptureState();
    STATE.scanActive = true;
    STATE.scan = sanitizeScanOptions(options);
    STATE.scanStartedAt = Date.now();
    STATE.stableRounds = 0;
    STATE.newNotesThisScan = 0;
    STATE.lastKnownCount = STATE.known.size;
    STATE.lastScrollHeight = document.documentElement.scrollHeight;
    STATE.phase = "down-1";
    scrollToTopForScan();
    const initial = enableCollection("start-scan", true, "list");
    chrome.runtime.sendMessage({
      type: "scanStatus",
      status: "running",
      knownCount: STATE.known.size,
      candidateCount: initial.candidates,
      pageType: initial.pageType,
      ...scanDiagnostics()
    }).catch(() => {});
    controlledScanStep();
    return { ok: true, started: true, candidateCount: initial.candidates, pageType: initial.pageType };
  }

  function resetCaptureState() {
    STATE.known = new Map();
    STATE.embeddedFingerprints = new Set();
    STATE.discoverySeq = 0;
    STATE.lastKnownCount = 0;
    STATE.newNotesThisScan = 0;
    STATE.stableRounds = 0;
    STATE.lastNewAt = 0;
  }

  function scrollToTopForScan() {
    try {
      if (typeof window.scrollTo === "function") {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
    } catch {
      try {
        window.scrollTo(0, 0);
      } catch {}
    }
  }

  function controlledScanStep() {
    if (!STATE.scanActive) return;
    const safetyStop = detectSafetyStop();
    if (safetyStop) {
      stopControlledScan(safetyStop);
      return;
    }
    captureVisibleCards("controlled-scan");
    captureEmbeddedJsonNotes("controlled-scan");

    const scan = STATE.scan || SCAN_DEFAULTS;
    const elapsedMinutes = (Date.now() - STATE.scanStartedAt) / 60000;
    if (elapsedMinutes > scan.maxMinutes) {
      stopControlledScan("max_duration");
      return;
    }
    if (STATE.newNotesThisScan >= scan.maxNewNotes) {
      stopControlledScan("max_new_notes_limit");
      return;
    }

    const before = window.scrollY;
    const direction = STATE.phase === "up" ? -1 : 1;
    window.scrollBy({ top: scanStepPx(scan) * direction, behavior: "smooth" });
    window.setTimeout(() => {
      captureVisibleCards("controlled-scan");
      captureEmbeddedJsonNotes("controlled-scan");
      const scrollHeight = document.documentElement.scrollHeight;
      const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 4;
      const atTop = window.scrollY <= 4;
      const moved = Math.abs(window.scrollY - before) > 5;
      const heightGrew = scrollHeight > STATE.lastScrollHeight + 4;
      const knownGrew = STATE.known.size > STATE.lastKnownCount;
      const atBoundary = (direction > 0 && atBottom) || (direction < 0 && atTop) || !moved;
      if (heightGrew || knownGrew) {
        STATE.stableRounds = 0;
      } else if (atBoundary) {
        STATE.stableRounds += 1;
      } else {
        STATE.stableRounds = 0;
      }
      STATE.lastScrollHeight = scrollHeight;
      STATE.lastKnownCount = STATE.known.size;

      chrome.runtime.sendMessage({
        type: "scanStatus",
        status: "running",
        knownCount: STATE.known.size,
        stableRounds: STATE.stableRounds,
        phase: STATE.phase,
        newNotesThisScan: STATE.newNotesThisScan,
        scrollHeight,
        ...scanDiagnostics()
      }).catch(() => {});

      if (STATE.stableRounds >= scan.stableRoundsToFinish) {
        if (STATE.phase === "down-1") {
          STATE.phase = "up";
          STATE.stableRounds = 0;
          STATE.scanTimer = window.setTimeout(controlledScanStep, scan.waitMs);
          return;
        }
        if (STATE.phase === "up") {
          STATE.phase = "down-2";
          STATE.stableRounds = 0;
          STATE.scanTimer = window.setTimeout(controlledScanStep, scan.waitMs);
          return;
        }
        stopControlledScan(finalScanReason());
        return;
      }
      STATE.scanTimer = window.setTimeout(controlledScanStep, scan.waitMs);
    }, scan.waitMs);
  }

  function stopControlledScan(reason) {
    STATE.scanActive = false;
    window.clearTimeout(STATE.scanTimer);
    if (STATE.collectionEnabled) captureVisibleCards("scan-stop");
    STATE.collectionEnabled = false;
    STATE.collectionMode = "idle";
    setBridgeActive(false);
    chrome.runtime.sendMessage({
      type: "scanStatus",
      status: "stopped",
      reason,
      knownCount: STATE.known.size,
      ...scanDiagnostics()
    }).catch(() => {});
  }

  function finalScanReason() {
    const expectedTotal = expectedNoteTotal();
    if (expectedTotal && STATE.known.size < expectedTotal) return "incomplete_expected_total";
    return "complete";
  }

  function reportSafetyStop(reason) {
    if (STATE.scanActive) {
      stopControlledScan(reason);
      return;
    }
    STATE.collectionEnabled = false;
    STATE.collectionMode = "idle";
    setBridgeActive(false);
    chrome.runtime.sendMessage({
      type: "scanStatus",
      status: "stopped",
      reason,
      knownCount: STATE.known.size,
      ...scanDiagnostics()
    }).catch(() => {});
  }

  function detectAccessWarning() {
    const body = textOf(document.body);
    if (/请打开小红书App扫码查看|This Page Isn.?t Available Right Now|Sorry, This Page/i.test(body)) return "access_limited";
    if (/(请先登录|登录后查看|扫码登录|验证码|安全验证|身份验证|验证身份|访问过于频繁|操作频繁|环境异常|账号异常|风险验证|请完成验证|请完成安全验证)/.test(body)) {
      return "verification_or_login_required";
    }
    return "";
  }

  function detectSafetyStop() {
    if (!/(^|\.)xiaohongshu\.com$/.test(location.hostname)) return "unexpected_domain";
    if (document.visibilityState !== "visible") return "page_hidden";
    return detectAccessWarning();
  }

  function sanitizeScanOptions(options) {
    return {
      stepPx: clampNumber(options.stepPx, 320, 1200, SCAN_DEFAULTS.stepPx),
      waitMs: clampNumber(options.waitMs, 900, 8000, SCAN_DEFAULTS.waitMs),
      stableRoundsToFinish: clampNumber(options.stableRoundsToFinish, 6, 30, SCAN_DEFAULTS.stableRoundsToFinish),
      maxMinutes: clampNumber(options.maxMinutes, 5, 720, SCAN_DEFAULTS.maxMinutes),
      maxNewNotes: clampNumber(options.maxNewNotes, 20, 50000, SCAN_DEFAULTS.maxNewNotes)
    };
  }

  function scanStepPx(scan) {
    const viewportStep = Math.max(320, Math.floor(Number(window.innerHeight || 0) * 0.65));
    return Math.min(scan.stepPx || SCAN_DEFAULTS.stepPx, viewportStep);
  }

  function scanDiagnostics() {
    const notes = Array.from(STATE.known.values());
    const missingTitle = notes.filter((note) => !note.title).length;
    const missingCover = notes.filter((note) => !note.cover).length;
    const missingUrl = notes.filter((note) => !note.url).length;
    const expectedTotal = expectedNoteTotal();
    return {
      expectedTotal,
      missingTitle,
      missingCover,
      missingUrl,
      coveragePercent: expectedTotal ? Math.min(100, Math.round(notes.length / expectedTotal * 1000) / 10) : 0,
      viewportTop: Math.round(Number(window.scrollY || 0)),
      viewportBottom: Math.round(Number(window.scrollY || 0) + Number(window.innerHeight || 0))
    };
  }

  function expectedNoteTotal() {
    const body = textOf(document.body);
    const match = body.match(/(?:笔记|收藏)[・·\s]*(\d{1,7})/);
    return match ? Number(match[1]) : 0;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function extractNoteId(url) {
    const match = String(url).match(/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/) ||
      String(url).match(/user\/profile\/[A-Za-z0-9_-]+\/([A-Za-z0-9]+)/);
    return match ? match[1] : "";
  }

  function textOf(node) {
    return node ? String(node.textContent || "").replace(/\s+/g, " ").trim() : "";
  }
})();
