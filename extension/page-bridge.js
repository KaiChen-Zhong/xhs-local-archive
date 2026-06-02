(function () {
  "use strict";

  const MAX_BODY_CHARS = 750000;
  const CAPTURE_PATH_PATTERN = /\/api\/sns\/web\/|\/api\/sns\/v\d+\/|\/api\/sns\/web_api\/|\/api\/sns\/web\/v\d+\/(homefeed|feed|note|comment|favorite|like|user|search)/i;
  const CAPTURE_QUERY_PATTERN = /(?:note|comment|favorite|collect|like|feed|homefeed|search)/i;
  let bridgeActive = false;
  let requestSeq = 0;

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "xhs-local-archive-control") return;
    bridgeActive = data.active !== false;
  });

  function shouldCapture(url) {
    try {
      if (!bridgeActive) return false;
      const parsed = new URL(url, location.href);
      if (!/(^|\.)xiaohongshu\.com$/.test(parsed.hostname)) return false;
      return CAPTURE_PATH_PATTERN.test(parsed.pathname) || CAPTURE_QUERY_PATTERN.test(parsed.search);
    } catch {
      return false;
    }
  }

  function postCapture(kind, url, body, seq) {
    if (!body || body.length > MAX_BODY_CHARS) return;
    window.postMessage({
      source: "xhs-local-archive",
      kind,
      url,
      body,
      requestSeq: seq || 0,
      ts: Date.now()
    }, "*");
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const seq = ++requestSeq;
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
    if (url && shouldCapture(url)) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("json") || contentType.includes("text")) {
        response.clone().text().then((text) => postCapture("fetch", url, text, seq)).catch(() => {});
      }
    }
    return response;
  };

  const OriginalXhr = window.XMLHttpRequest;
  const originalOpen = OriginalXhr.prototype.open;
  const originalSend = OriginalXhr.prototype.send;

  OriginalXhr.prototype.open = function (method, url, ...rest) {
    this.__xhsArchiveUrl = url;
    this.__xhsArchiveSeq = ++requestSeq;
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXhr.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      const url = this.__xhsArchiveUrl;
      if (!url || !shouldCapture(url)) return;
      const contentType = this.getResponseHeader("content-type") || "";
      if (!contentType.includes("json") && !contentType.includes("text")) return;
      if (typeof this.responseText === "string") {
        postCapture("xhr", url, this.responseText, this.__xhsArchiveSeq || 0);
      }
    });
    return originalSend.apply(this, args);
  };
})();
