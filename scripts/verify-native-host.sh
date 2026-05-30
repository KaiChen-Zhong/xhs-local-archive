#!/bin/sh
set -eu

extension_id="${1:-}"
browser="${2:-Chrome}"

if [ -n "$extension_id" ] && ! printf '%s' "$extension_id" | grep -Eq '^[a-p]{32}$'; then
  echo "ExtensionId must be a 32-character Chromium extension id using letters a-p." >&2
  exit 1
fi

case "$browser" in
  Chrome)
    manifest_path="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.xhs_archive.host.json"
    ;;
  Edge)
    manifest_path="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.xhs_archive.host.json"
    ;;
  *)
    echo "Browser must be Chrome or Edge." >&2
    exit 1
    ;;
esac

node_path="$(command -v node || true)"
if [ -z "$node_path" ]; then
  echo "Node.js is required but was not found on PATH." >&2
  exit 1
fi

MANIFEST_PATH="$manifest_path" EXTENSION_ID="$extension_id" BROWSER="$browser" "$node_path" <<'NODE'
const childProcess = require("node:child_process");
const fs = require("node:fs");

const manifestPath = process.env.MANIFEST_PATH;
if (!fs.existsSync(manifestPath)) throw new Error(`Native host manifest not found: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.name !== "com.xhs_archive.host") throw new Error(`Unexpected native host name: ${manifest.name}`);
if (manifest.type !== "stdio") throw new Error(`Unexpected native host type: ${manifest.type}`);
if (!manifest.path || !fs.existsSync(manifest.path)) throw new Error(`Native host executable path not found: ${manifest.path}`);
if (process.env.EXTENSION_ID) {
  const origin = `chrome-extension://${process.env.EXTENSION_ID}/`;
  if (!manifest.allowed_origins.includes(origin)) throw new Error(`Allowed origin mismatch. Expected ${origin}`);
}

const child = childProcess.spawn(manifest.path, [], { stdio: ["pipe", "pipe", "pipe"] });
const request = Buffer.from(JSON.stringify({ type: "ping" }), "utf8");
const header = Buffer.alloc(4);
header.writeUInt32LE(request.length, 0);
child.stdin.end(Buffer.concat([header, request]));
let output = Buffer.alloc(0);
let error = "";
child.stdout.on("data", (chunk) => { output = Buffer.concat([output, chunk]); });
child.stderr.on("data", (chunk) => { error += chunk; });
const timer = setTimeout(() => {
  child.kill();
  throw new Error("Native host ping timed out.");
}, 5000);
child.on("close", () => {
  clearTimeout(timer);
  if (output.length < 4) throw new Error(`Native host returned no protocol response. ${error}`);
  const length = output.readUInt32LE(0);
  const response = JSON.parse(output.subarray(4, 4 + length).toString("utf8"));
  if (!response.ok) throw new Error(`Native host ping failed: ${response.error || "unknown"}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    browser: process.env.BROWSER,
    manifestPath,
    hostPath: manifest.path,
    allowedOrigins: manifest.allowed_origins,
    archiveRoot: response.archiveRoot
  }, null, 2)}\n`);
});
NODE
