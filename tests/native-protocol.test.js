"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("native host speaks Chrome Native Messaging protocol", async () => {
  const hostPath = path.join(__dirname, "..", "native-host", "host.js");
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-native-protocol-"));
  const child = childProcess.spawn(process.execPath, [hostPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XHS_ARCHIVE_DIR: archiveRoot }
  });
  const responsePromise = readNativeResponse(child);
  writeNativeMessage(child, { type: "ping" });
  const response = await responsePromise;
  child.kill();
  assert.equal(response.ok, true);
  assert.equal(response.archiveRoot, archiveRoot);
  assert.equal(fs.existsSync(path.join(archiveRoot, "database.json")), false);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
});

function writeNativeMessage(child, payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  child.stdin.write(header);
  child.stdin.write(json);
}

function readNativeResponse(child) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("native_response_timeout"));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      clearTimeout(timeout);
      resolve(JSON.parse(buffer.slice(4, length + 4).toString("utf8")));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
