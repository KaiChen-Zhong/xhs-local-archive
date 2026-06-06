"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { handleMessage } = require("../native-host/host.js");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const mimoPath = args.get("--mimo") || path.join(process.env.USERPROFILE || "", "Downloads", "mimo.txt");
const batchSize = Number(args.get("--batch-size") || process.env.XHS_CLASSIFY_BATCH_SIZE || 30);
const logPath = args.get("--log") || path.join(process.env.USERPROFILE || "", "XHS-Archive", "classify-run.log");
const holdLock = String(args.get("--hold-lock") || "").toLowerCase() === "true";

if (args.has("--help") || args.has("-h")) {
  console.log([
    "Usage: node scripts/run-classify-all.js [--mimo <path>] [--batch-size <n>] [--log <path>] [--hold-lock true]",
    "",
    "默认会释放分类写锁；只有调试旧版插件覆盖问题时才使用 --hold-lock true。"
  ].join("\n"));
  process.exit(0);
}

function readMimoSettings(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim());
  const models = String(lines[2] || "").split(/[、,，\s]+/).filter(Boolean);
  if (!lines[0] || models.length < 2 || !lines[4]) throw new Error("mimo_config_incomplete");
  return {
    text: { baseUrl: lines[0], model: models[0], apiKey: lines[4] },
    vision: { baseUrl: lines[0], model: models[1], apiKey: lines[4] }
  };
}

async function main() {
  const started = Date.now();
  await handleMessage({ type: "saveSettings", settings: { ai: readMimoSettings(mimoPath) } });
  const result = await handleMessage({
    type: "classifyAll",
    requireAi: true,
    forceUnclassified: true,
    holdLock,
    batchSize
  });
  fs.writeFileSync(logPath, JSON.stringify({
    ok: true,
    elapsedMs: Date.now() - started,
    result
  }, null, 2), "utf8");
}

main().catch((error) => {
  fs.writeFileSync(logPath, JSON.stringify({
    ok: false,
    error: error && error.stack || String(error)
  }, null, 2), "utf8");
  process.exit(1);
});
