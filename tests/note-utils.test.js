"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  stableNoteId,
  sourceUrlWithToken,
  sanitizeFilename,
  mergeNote,
  canArchiveNote,
  noteCompleteness,
  renderMarkdown
} = require("../shared/note-utils");

process.env.XHS_ARCHIVE_DIR = path.join(os.tmpdir(), `xhs-archive-tests-${process.pid}`);
fs.rmSync(process.env.XHS_ARCHIVE_DIR, { recursive: true, force: true });
process.env.XHS_MEDIA_DOWNLOAD_DELAY_MS = "0";
const { handleMessage, buildLocalAiFallback } = require("../native-host/host");

test("stableNoteId extracts explore ids", () => {
  assert.equal(stableNoteId("https://www.xiaohongshu.com/explore/abc123?xsec_token=t"), "abc123");
  assert.equal(stableNoteId("https://www.xiaohongshu.com/user/profile/user123/abc123?xsec_token=t"), "abc123");
});

test("sourceUrlWithToken preserves xsec_token on XHS source links", () => {
  assert.equal(
    sourceUrlWithToken("https://www.xiaohongshu.com/explore/abc123", "token-1"),
    "https://www.xiaohongshu.com/explore/abc123?xsec_token=token-1"
  );
  assert.equal(
    sourceUrlWithToken("https://www.xiaohongshu.com/explore/abc123?xsec_token=old", "token-1"),
    "https://www.xiaohongshu.com/explore/abc123?xsec_token=old"
  );
  assert.equal(
    sourceUrlWithToken("https://example.com/explore/abc123", "token-1"),
    "https://example.com/explore/abc123"
  );
});

test("sanitizeFilename removes unsafe characters", () => {
  assert.equal(sanitizeFilename("a<b:c>d/e\\f|g?h*"), "a b c d e f g h");
});

test("mergeNote preserves media and comments", () => {
  const merged = mergeNote(
    { noteId: "n1", images: ["1.jpg"], comments: [{ user: "u", text: "ok" }] },
    { noteId: "n1", images: ["1.jpg", "2.jpg"], comments: [{ user: "u", text: "ok" }, { user: "v", text: "good", likes: 2 }] }
  );
  assert.deepEqual(merged.images, ["1.jpg", "2.jpg"]);
  assert.equal(merged.comments.length, 2);
});

test("mergeNote appends stored xsec_token to source url", () => {
  const merged = mergeNote(
    { noteId: "n1", url: "https://www.xiaohongshu.com/explore/n1" },
    { noteId: "n1", xsecToken: "token-1" }
  );
  assert.equal(merged.url, "https://www.xiaohongshu.com/explore/n1?xsec_token=token-1");
});

test("noteCompleteness reports captured levels", () => {
  assert.equal(noteCompleteness({ noteId: "n1" }), "discovered");
  assert.equal(noteCompleteness({ noteId: "n1", text: "body" }), "discovered");
  assert.equal(noteCompleteness({ noteId: "n1", comments: [{ text: "x" }] }), "discovered");
  assert.equal(noteCompleteness({ noteId: "n1", markdownPath: "a.md", title: "card" }), "archived");
  assert.equal(noteCompleteness({ noteId: "n1", text: "body", markdownPath: "a.md" }), "archived");
  assert.equal(canArchiveNote({ noteId: "n1", cover: "cover.jpg" }), true);
  assert.equal(canArchiveNote({ noteId: "n1", images: ["image.jpg"] }), true);
});

test("renderMarkdown includes source, status, and highlights", () => {
  const markdown = renderMarkdown({ noteId: "n1", url: "https://x", title: "Title", text: "Body" }, { category: "测试", tags: ["tag"], summary: "sum", highlights: "重点一" });
  assert.match(markdown, /note_id: n1/);
  assert.match(markdown, /source_url: https:\/\/x/);
  assert.match(markdown, /# Title/);
  assert.match(markdown, /## 精华内容/);
  assert.match(markdown, /重点一/);
});

test("native host upserts and lists notes", async () => {
  const note = { noteId: `test-${Date.now()}`, title: "Test note", url: "https://www.xiaohongshu.com/explore/test" };
  const upsert = await handleMessage({ type: "upsertNotes", notes: [note] });
  assert.equal(upsert.ok, true);
  const list = await handleMessage({ type: "listNotes" });
  assert.equal(list.ok, true);
  assert.ok(list.notes.some((item) => item.noteId === note.noteId));
});

test("native host archives markdown", async () => {
  const note = {
    noteId: `archive-${Date.now()}`,
    title: "Archive note",
    url: "https://www.xiaohongshu.com/explore/archive",
    text: "Body for archive test"
  };
  const upsert = await handleMessage({ type: "upsertNotes", notes: [note] });
  assert.equal(upsert.ok, true);
  const archived = await handleMessage({ type: "archiveNote", noteId: note.noteId });
  assert.equal(archived.ok, true);
  assert.ok(archived.note.markdownPath.endsWith(".md"));
  assert.match(archived.note.status, /archived/);
});

test("native host archives title-cover card records", async () => {
  const note = {
    noteId: `card-only-${Date.now()}`,
    title: "Card only",
    cover: "https://img.example/cover.jpg",
    url: "https://www.xiaohongshu.com/explore/card-only"
  };
  assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
  const result = await handleMessage({ type: "archiveNote", noteId: note.noteId });
  assert.equal(result.ok, true);
  const list = await handleMessage({ type: "listNotes" });
  const stored = list.notes.find((item) => item.noteId === note.noteId);
  assert.ok(stored.markdownPath.endsWith(".md"));
  assert.equal(stored.status, "archived");
});

test("native host blocks private media URLs during archive", async () => {
  const note = {
    noteId: `private-media-${Date.now()}`,
    title: "Private media",
    url: "https://www.xiaohongshu.com/explore/private-media",
    images: ["http://127.0.0.1:1/image.jpg"]
  };
  assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
  const archived = await handleMessage({ type: "archiveNote", noteId: note.noteId });
  assert.equal(archived.ok, true);
  assert.deepEqual(archived.note.localImages, []);
  assert.equal(archived.note.mediaErrors[0].error, "blocked_private_host");
  assert.equal(fs.existsSync(archived.note.markdownPath), true);
});

test("native host report includes counts and archive root", async () => {
  const report = await handleMessage({ type: "getReport" });
  assert.equal(report.ok, true);
  assert.ok(report.report.archiveRoot);
  assert.ok(Number.isFinite(report.report.total));
  assert.equal(typeof report.report.counts, "object");
});

test("native host uses OpenAI-compatible settings when archiving", async () => {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.match(body, /AI mock note|AI provider test/);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                category: "测试分类",
                tags: ["AI测试"],
                summary: "AI mock summary",
                highlights: ["AI mock highlight", "AI mock second highlight"],
                filename: "AI mock filename"
              })
            }
          }
        ]
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const note = {
      noteId: `ai-${Date.now()}`,
      title: "AI mock note",
      url: "https://www.xiaohongshu.com/explore/ai",
      text: "需要 AI 总结的正文"
    };
    const settings = {
      ai: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "mock-model",
        apiKey: "mock-key"
      }
    };
    assert.equal((await handleMessage({ type: "saveSettings", settings })).ok, true);
    const rawDatabase = fs.readFileSync(path.join(process.env.XHS_ARCHIVE_DIR, "database.json"), "utf8");
    assert.doesNotMatch(rawDatabase, /mock-key/);
    assert.match(rawDatabase, /apiKeyProtected/);
    const publicSettings = await handleMessage({ type: "getSettings" });
    assert.equal(publicSettings.settings.ai.apiKeyConfigured, true);
    assert.equal(publicSettings.settings.ai.apiKey, undefined);
    assert.equal(publicSettings.settings.ai.apiKeyProtected, undefined);
    const providerTest = await handleMessage({ type: "testAiProvider" });
    assert.equal(providerTest.ok, true);
    assert.equal(providerTest.model, "mock-model");
    assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
    const archived = await handleMessage({ type: "archiveNote", noteId: note.noteId });
    assert.equal(archived.ok, true);
    assert.equal(archived.note.ai.category, "测试分类");
    assert.equal(archived.note.ai.summary, "AI mock summary");
    assert.equal(archived.note.ai.highlights, "AI mock highlight\nAI mock second highlight");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await handleMessage({ type: "saveSettings", settings: { ai: {} }, clearAiKey: true });
  }
});

test("local AI fallback classifies from title and cover only", () => {
  const fallback = buildLocalAiFallback({
    title: "咖啡店收藏",
    text: "这段正文不应参与分类",
    cover: "https://img.example/coffee-cover.jpg",
    comments: [
      { text: "普通评论", likes: 1 },
      { text: "高赞评论", likes: 88 },
      { text: "次高赞评论", likes: 12 }
    ]
  });
  assert.equal(fallback.category, "美食");
  assert.equal(fallback.subcategory, "咖啡甜品");
  assert.match(fallback.summary, /咖啡店收藏/);
  assert.doesNotMatch(fallback.summary, /正文/);
  assert.doesNotMatch(fallback.highlights, /高赞评论/);
});

test("native host retries AI classification without image content when provider rejects vision payload", async () => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      calls += 1;
      if (body.includes("image_url")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "vision_not_supported" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                categoryPath: ["美食", "咖啡甜品"],
                tags: ["咖啡"],
                summary: "retried without image",
                highlights: "cover url fallback",
                filename: "vision-fallback"
              })
            }
          }
        ]
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await handleMessage({
      type: "saveSettings",
      settings: {
        ai: {
          vision: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "mock-model",
            apiKey: "mock-key"
          }
        }
      }
    });
    const note = {
      noteId: `vision-fallback-${Date.now()}`,
      title: "咖啡店收藏",
      cover: "https://img.example/coffee.jpg",
      url: "https://www.xiaohongshu.com/explore/vision-fallback"
    };
    assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
    const classified = await handleMessage({ type: "classifyNote", noteId: note.noteId });
    assert.equal(classified.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(classified.note.ai.categoryPath, ["未分类", "待细分"]);
    assert.deepEqual(classified.note.ai.proposedCategoryPath, ["美食", "咖啡甜品"]);
    assert.equal(classified.note.ai.taxonomyPending, true);
    assert.equal(classified.note.ai.visionFallback, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await handleMessage({ type: "saveSettings", settings: { ai: {} }, clearAiKey: true });
  }
});

test("native host combines text and vision AI before governing classification", async () => {
  const calls = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const server = http.createServer((request, response) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      calls.push({ model: parsed.model, hasImage: body.includes("image_url"), isFusion: body.includes("text_ai_analysis") });
      const categoryPath = body.includes("text_ai_analysis")
        ? ["美食", "咖啡甜品"]
        : parsed.model === "vision-model"
          ? ["美食", "咖啡视觉"]
          : ["美食", "咖啡文本"];
      setTimeout(() => {
        activeRequests -= 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  categoryPath,
                  tags: ["咖啡"],
                  summary: `${parsed.model} summary`,
                  highlights: "dual ai",
                  confidence: 0.8,
                  filename: "dual-ai"
                })
              }
            }
          ]
        }));
      }, 40);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await handleMessage({
      type: "saveSettings",
      settings: {
        ai: {
          text: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "text-model",
            apiKey: "text-key"
          },
          vision: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "vision-model",
            apiKey: "vision-key"
          }
        }
      }
    });
    const seed = {
      noteId: `dual-seed-${Date.now()}`,
      title: "咖啡分类种子",
      url: "https://www.xiaohongshu.com/explore/dual-seed"
    };
    const note = {
      noteId: `dual-ai-${Date.now()}`,
      title: "咖啡店收藏",
      cover: "https://img.example/coffee.jpg",
      url: "https://www.xiaohongshu.com/explore/dual-ai"
    };
    assert.equal((await handleMessage({ type: "upsertNotes", notes: [seed, note] })).ok, true);
    assert.equal((await handleMessage({
      type: "updateClassification",
      noteId: seed.noteId,
      classification: { categoryPath: ["美食", "咖啡甜品"] }
    })).ok, true);
    const classified = await handleMessage({ type: "classifyNote", noteId: note.noteId });
    assert.equal(classified.ok, true);
    assert.deepEqual(classified.note.ai.categoryPath, ["美食", "咖啡甜品"]);
    assert.equal(classified.note.ai.aiPipeline.mode, "dual");
    assert.equal(calls.length, 3);
    assert.equal(calls.some((call) => call.model === "vision-model" && call.hasImage), true);
    assert.equal(calls.some((call) => call.model === "text-model" && call.isFusion), true);
    assert.equal(maxActiveRequests >= 2, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await handleMessage({ type: "saveSettings", settings: { ai: {} }, clearAiKey: true });
  }
});

test("native host classifies and manually updates category hierarchy", async () => {
  const note = {
    noteId: `classify-${Date.now()}`,
    title: "通勤穿搭灵感",
    cover: "https://img.example/ootd.jpg",
    url: "https://www.xiaohongshu.com/explore/classify"
  };
  assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
  const classified = await handleMessage({ type: "classifyNote", noteId: note.noteId });
  assert.equal(classified.ok, true);
  assert.equal(classified.note.ai.category, "穿搭");
  assert.equal(classified.note.ai.subcategory, "日常穿搭");
  assert.deepEqual(classified.note.ai.categoryPath, ["穿搭", "日常穿搭"]);
  const updated = await handleMessage({
    type: "updateClassification",
    noteId: note.noteId,
    classification: { categoryPath: ["审美", "通勤参考", "春夏"] }
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.note.ai.category, "审美");
  assert.equal(updated.note.ai.subcategory, "通勤参考");
  assert.deepEqual(updated.note.ai.categoryPath, ["审美", "通勤参考", "春夏"]);
});

test("native host governs taxonomy with lock and merge", async () => {
  const source = {
    noteId: `tax-source-${Date.now()}`,
    title: "咖啡馆合集",
    cover: "https://img.example/cafe.jpg",
    url: "https://www.xiaohongshu.com/explore/tax-source"
  };
  const target = {
    noteId: `tax-target-${Date.now()}`,
    title: "咖啡甜品收藏",
    cover: "https://img.example/coffee.jpg",
    url: "https://www.xiaohongshu.com/explore/tax-target"
  };
  assert.equal((await handleMessage({ type: "upsertNotes", notes: [source, target] })).ok, true);
  assert.equal((await handleMessage({
    type: "updateClassification",
    noteId: source.noteId,
    classification: { categoryPath: ["餐饮", "咖啡馆"] }
  })).ok, true);
  assert.equal((await handleMessage({
    type: "updateClassification",
    noteId: target.noteId,
    classification: { categoryPath: ["美食", "咖啡甜品"] }
  })).ok, true);
  const locked = await handleMessage({ type: "lockTaxonomy", path: "美食/咖啡甜品" });
  assert.equal(locked.ok, true);
  assert.equal(locked.entry.locked, true);
  const merged = await handleMessage({ type: "mergeTaxonomy", from: "餐饮/咖啡馆", to: "美食/咖啡甜品" });
  assert.equal(merged.ok, true);
  assert.equal(merged.changed >= 1, true);
  const list = await handleMessage({ type: "listNotes" });
  const sourceAfter = list.notes.find((note) => note.noteId === source.noteId);
  assert.deepEqual(sourceAfter.ai.categoryPath, ["美食", "咖啡甜品"]);
  const taxonomy = await handleMessage({ type: "getTaxonomy" });
  assert.equal(taxonomy.ok, true);
  const entry = taxonomy.taxonomy.entries.find((item) => item.path.join("/") === "美食/咖啡甜品");
  assert.ok(entry.aliases.includes("餐饮/咖啡馆"));
});

test("native host keeps AI taxonomy proposals pending until approved", async () => {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                categoryPath: ["香氛", "居家香薰", "木质调", "扩香石", "卧室"],
                tags: ["香氛"],
                summary: "AI taxonomy proposal",
                highlights: "cover only",
                filename: "ai-taxonomy-proposal"
              })
            }
          }
        ]
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await handleMessage({
      type: "saveSettings",
      settings: {
        ai: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "mock-model",
          apiKey: "mock-key"
        }
      }
    });
    const note = {
      noteId: `ai-pending-${Date.now()}`,
      title: "卧室木质香薰",
      cover: "https://img.example/aroma.jpg",
      url: "https://www.xiaohongshu.com/explore/ai-pending"
    };
    assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
    const classified = await handleMessage({ type: "classifyNote", noteId: note.noteId });
    assert.equal(classified.ok, true);
    assert.deepEqual(classified.note.ai.categoryPath, ["未分类", "待细分"]);
    assert.equal(classified.note.ai.taxonomyPending, true);
    assert.deepEqual(classified.note.ai.proposedCategoryPath, ["香氛", "居家香薰", "木质调", "扩香石", "卧室"]);
    const taxonomy = await handleMessage({ type: "getTaxonomy" });
    const pending = taxonomy.taxonomy.pendingNodes.find((item) => item.path.join("/") === "香氛/居家香薰/木质调/扩香石/卧室");
    assert.ok(pending);
    const approved = await handleMessage({ type: "approveTaxonomyPath", key: pending.key });
    assert.equal(approved.ok, true);
    assert.equal(approved.changed >= 1, true);
    const list = await handleMessage({ type: "listNotes" });
    const updated = list.notes.find((item) => item.noteId === note.noteId);
    assert.deepEqual(updated.ai.categoryPath, ["香氛", "居家香薰", "木质调", "扩香石", "卧室"]);
    const after = await handleMessage({ type: "getTaxonomy" });
    assert.ok(after.taxonomy.nodes.some((item) => item.level === 5 && item.path.join("/") === "香氛/居家香薰/木质调/扩香石/卧室"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await handleMessage({ type: "saveSettings", settings: { ai: {} }, clearAiKey: true });
  }
});

test("native host reports incomplete AI settings", async () => {
  await handleMessage({ type: "saveSettings", settings: { ai: {} }, clearAiKey: true });
  const result = await handleMessage({ type: "testAiProvider" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "ai_settings_incomplete");
});

test("native host deleteLocal removes archived note and markdown", async () => {
  const note = {
    noteId: `delete-${Date.now()}`,
    title: "Delete note",
    url: "https://www.xiaohongshu.com/explore/delete",
    text: "Delete body"
  };
  assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
  const archived = await handleMessage({ type: "archiveNote", noteId: note.noteId });
  assert.equal(archived.ok, true);
  assert.equal(fs.existsSync(archived.note.markdownPath), true);
  const deleted = await handleMessage({ type: "deleteLocal", noteIds: [note.noteId] });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(archived.note.markdownPath), false);
  const list = await handleMessage({ type: "listNotes" });
  assert.equal(list.notes.some((item) => item.noteId === note.noteId), false);
});

test("native host deleteLocal refuses paths outside archive root", async () => {
  const outsideDir = `${process.env.XHS_ARCHIVE_DIR}-sibling`;
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, "must-stay.txt");
  fs.writeFileSync(outsideFile, "keep", "utf8");
  const note = {
    noteId: `outside-delete-${Date.now()}`,
    title: "Outside delete guard",
    url: "https://www.xiaohongshu.com/explore/outside-delete",
    text: "Delete guard body",
    localImages: [outsideFile]
  };
  assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
  const deleted = await handleMessage({ type: "deleteLocal", noteIds: [note.noteId] });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(outsideFile), true);
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test("native host reads only archive-root local media", async () => {
  const mediaDir = path.join(process.env.XHS_ARCHIVE_DIR, "media", "read-test");
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaFile = path.join(mediaDir, "image.png");
  fs.writeFileSync(mediaFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await handleMessage({ type: "readLocalMedia", file: mediaFile });
  assert.equal(result.ok, true);
  assert.equal(result.contentType, "image/png");
  assert.match(result.dataUrl, /^data:image\/png;base64,/);

  const outsideDir = `${process.env.XHS_ARCHIVE_DIR}-media-outside`;
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, "image.png");
  fs.writeFileSync(outsideFile, "outside", "utf8");
  const denied = await handleMessage({ type: "readLocalMedia", file: outsideFile });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "media_path_denied");
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test("native host builds insights and exports archive index", async () => {
  const note = {
    noteId: `insight-${Date.now()}`,
    title: "上海咖啡店合集",
    url: "https://www.xiaohongshu.com/explore/insight",
    text: "美食 咖啡 甜品",
    ai: { category: "美食", tags: ["咖啡", "甜品"], summary: "summary", highlights: "highlight" }
  };
  assert.equal((await handleMessage({ type: "upsertNotes", notes: [note] })).ok, true);
  const insights = await handleMessage({ type: "getInsights" });
  assert.equal(insights.ok, true);
  assert.ok(insights.insights.total >= 1);
  assert.ok(insights.insights.persona.name);
  assert.equal(typeof insights.insights.receipt.statuses, "object");
  assert.ok(insights.insights.achievements.length >= 30);
  const exported = await handleMessage({ type: "exportAll" });
  assert.equal(exported.ok, true);
  assert.equal(fs.existsSync(exported.jsonPath), true);
  assert.equal(fs.existsSync(exported.indexPath), true);
  assert.equal(fs.existsSync(exported.csvPath), true);
  assert.equal(fs.existsSync(exported.jsonlPath), true);
  const index = fs.readFileSync(exported.indexPath, "utf8");
  assert.match(index, /小红书本地归档索引/);
  const csv = fs.readFileSync(exported.csvPath, "utf8");
  assert.match(csv, /"Title","URL","Author".*"Highlights"/);
  assert.match(csv, /"highlight"/);
  const jsonl = fs.readFileSync(exported.jsonlPath, "utf8").trim().split("\n");
  assert.ok(jsonl.length >= 1);
  const firstJsonl = JSON.parse(jsonl[0]);
  assert.equal(Object.prototype.hasOwnProperty.call(firstJsonl, "highlights"), true);
  const selfTest = await handleMessage({ type: "exportSelfTest" });
  assert.equal(selfTest.ok, true);
  assert.equal(fs.existsSync(selfTest.selfTestPath), true);
  const selfTestJson = JSON.parse(fs.readFileSync(selfTest.selfTestPath, "utf8"));
  assert.equal(selfTestJson.checks.archiveRootExists, true);
  assert.ok(Array.isArray(selfTestJson.acceptanceChecklist));
  assert.ok(selfTestJson.acceptanceChecklist.some((item) => item.id === "native_host" && item.pass));
  assert.ok(Array.isArray(selfTestJson.manualXhsChecklist));
  assert.ok(selfTestJson.manualXhsChecklist.some((item) => item.id === "title_cover_only"));
  const savedManual = await handleMessage({
    type: "saveManualXhsValidation",
    validation: { passed: true, source: "test" }
  });
  assert.equal(savedManual.ok, true);
  const verifiedSelfTest = await handleMessage({ type: "exportSelfTest" });
  const verifiedSelfTestJson = JSON.parse(fs.readFileSync(verifiedSelfTest.selfTestPath, "utf8"));
  assert.equal(verifiedSelfTestJson.manualXhsValidation.passed, true);
  const manualItem = verifiedSelfTestJson.manualXhsChecklist.find((item) => item.id === "title_cover_only");
  assert.equal(manualItem.pass, true);
  assert.equal(manualItem.source, "test");
  assert.match(manualItem.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
});
