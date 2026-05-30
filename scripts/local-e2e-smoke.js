"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const keep = process.argv.includes("--keep");
const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-local-e2e-"));
process.env.XHS_ARCHIVE_DIR = archiveRoot;
process.env.XHS_MEDIA_DOWNLOAD_DELAY_MS = "0";

const { handleMessage } = require("../native-host/host");

async function main() {
  const noteId = `e2e-${Date.now()}`;
  const note = {
    noteId,
    title: "Weekend coffee guide",
    author: "demo-author",
    url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=demo`,
    xsecToken: "demo",
    cover: "https://img.example/coffee.jpg",
    statuses: {
      networkCaptured: true,
      cardOnly: true
    },
    createdAt: new Date().toISOString()
  };

  assert.equal((await handleMessage({ type: "ping" })).ok, true);

  const upsert = await handleMessage({ type: "upsertNotes", notes: [note] });
  assert.equal(upsert.ok, true);
  assert.deepEqual(upsert.upserted, [noteId]);

  const listedAfterUpsert = await handleMessage({ type: "listNotes" });
  assert.equal(listedAfterUpsert.ok, true);
  assert.equal(listedAfterUpsert.notes.some((item) => item.noteId === noteId && item.status === "discovered"), true);

  const prematureManual = await handleMessage({
    type: "saveManualXhsValidation",
    validation: { passed: true, source: "local-e2e" }
  });
  assert.equal(prematureManual.ok, false);
  assert.equal(prematureManual.error, "manual_validation_prerequisites_missing");
  assert.equal(prematureManual.prerequisites.notesSeen, true);
  assert.equal(prematureManual.prerequisites.classified, false);
  assert.equal(prematureManual.prerequisites.markdownArchived, false);

  const classified = await handleMessage({ type: "classifyNote", noteId });
  assert.equal(classified.ok, true);
  assert.deepEqual(classified.note.ai.categoryPath, ["美食", "咖啡甜品"]);

  const archived = await handleMessage({ type: "archiveNote", noteId });
  assert.equal(archived.ok, true);
  assert.equal(archived.note.status, "archived");
  assert.equal(fs.existsSync(archived.note.markdownPath), true);
  assert.match(fs.readFileSync(archived.note.markdownPath, "utf8"), /Weekend coffee guide/);

  const manual = await handleMessage({
    type: "saveManualXhsValidation",
    validation: { passed: true, source: "local-e2e" }
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.validation.passed, true);

  const exported = await handleMessage({ type: "exportAll" });
  assert.equal(exported.ok, true);
  for (const file of [exported.jsonPath, exported.indexPath, exported.csvPath, exported.jsonlPath]) {
    assert.equal(fs.existsSync(file), true, file);
  }

  const selfTest = await handleMessage({ type: "exportSelfTest" });
  assert.equal(selfTest.ok, true);
  const selfTestJson = JSON.parse(fs.readFileSync(selfTest.selfTestPath, "utf8"));
  assert.equal(selfTestJson.acceptanceChecklist.some((item) => item.id === "native_host" && item.pass), true);
  assert.equal(selfTestJson.acceptanceChecklist.some((item) => item.id === "markdown_written" && item.pass), true);
  assert.equal(selfTestJson.manualXhsValidation.passed, true);
  assert.equal(selfTestJson.manualXhsValidation.source, "local-e2e");
  assert.equal(selfTestJson.manualXhsChecklist.some((item) => item.id === "title_cover_only" && item.pass), true);

  const deleted = await handleMessage({ type: "deleteLocal", noteIds: [noteId] });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(archived.note.markdownPath), false);

  const listedAfterDelete = await handleMessage({ type: "listNotes" });
  assert.equal(listedAfterDelete.notes.some((item) => item.noteId === noteId), false);

  console.log(JSON.stringify({
    ok: true,
    archiveRoot,
    noteId,
    exported: {
      jsonPath: exported.jsonPath,
      indexPath: exported.indexPath,
      csvPath: exported.csvPath,
      jsonlPath: exported.jsonlPath,
      selfTestPath: selfTest.selfTestPath
    }
  }, null, 2));
}

main().finally(() => {
  if (keep) return;
  const resolved = path.resolve(archiveRoot);
  const tmp = path.resolve(os.tmpdir());
  if (resolved.startsWith(tmp + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
