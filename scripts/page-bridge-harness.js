"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createResponse(body, contentType = "application/json") {
  return {
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? contentType : "";
      }
    },
    clone() {
      return {
        async text() {
          return body;
        }
      };
    }
  };
}

async function main() {
  const posted = [];
  const messageListeners = [];
  const requests = [];
  class FakeXhr {
    open() {}
    send() {}
    addEventListener() {}
    getResponseHeader() { return ""; }
  }
  const context = {
    URL,
    location: { href: "https://www.xiaohongshu.com/explore", hostname: "www.xiaohongshu.com" },
    window: {
      addEventListener(type, callback) {
        if (type === "message") messageListeners.push(callback);
      },
      postMessage(payload) {
        posted.push(payload);
      },
      fetch: async (url) => {
        requests.push(url);
        return createResponse(JSON.stringify({ url }));
      },
      XMLHttpRequest: FakeXhr
    }
  };
  context.globalThis = context;
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", "page-bridge.js"), "utf8"), context, {
    filename: "page-bridge.js"
  });

  await context.window.fetch("https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=default-disabled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted.length, 0);

  messageListeners[0]({ data: { source: "xhs-local-archive-control", active: true } });
  await context.window.fetch("https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=abc");
  await context.window.fetch("https://www.xiaohongshu.com/favicon.json");
  await context.window.fetch("https://evilxiaohongshu.com/api/sns/web/v2/comment/page?note_id=abc");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(requests.length, 4);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, "fetch");
  assert.match(posted[0].url, /comment\/page/);

  messageListeners[0]({ data: { source: "xhs-local-archive-control", active: false } });
  await context.window.fetch("https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=disabled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted.length, 1);

  messageListeners[0]({ data: { source: "xhs-local-archive-control", active: true } });
  await context.window.fetch("https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=enabled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted.length, 2);

  console.log(JSON.stringify({
    ok: true,
    checks: ["defaultInactive", "allowedApiCaptured", "unrelatedXhsIgnored", "lookalikeDomainIgnored", "bridgeDisable", "bridgeEnable"]
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
