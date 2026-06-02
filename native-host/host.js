#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const net = require("net");
const crypto = require("crypto");
const {
  mergeNote,
  canArchiveNote,
  noteCompleteness,
  renderMarkdown,
  sanitizeFilename,
  sourceUrlWithToken,
  summarizeForFilename
} = require("../shared/note-utils");

const archiveRoot = process.env.XHS_ARCHIVE_DIR || path.join(os.homedir(), "XHS-Archive");
const dbPath = path.join(archiveRoot, "database.json");
const portableKeyPath = path.join(archiveRoot, ".secret-key");
const MEDIA_DOWNLOAD_TIMEOUT_MS = parseEnvInt("XHS_MEDIA_DOWNLOAD_TIMEOUT_MS", 30000);
const MEDIA_DOWNLOAD_DELAY_MS = parseEnvInt("XHS_MEDIA_DOWNLOAD_DELAY_MS", 800);
const MEDIA_MAX_IMAGE_BYTES = parseEnvInt("XHS_MEDIA_MAX_IMAGE_BYTES", 50 * 1024 * 1024);
const MEDIA_MAX_VIDEO_BYTES = parseEnvInt("XHS_MEDIA_MAX_VIDEO_BYTES", 300 * 1024 * 1024);
const MEDIA_READ_MAX_BYTES = parseEnvInt("XHS_MEDIA_READ_MAX_BYTES", 25 * 1024 * 1024);
const CLASSIFY_ALL_LIMIT = parseEnvInt("XHS_CLASSIFY_ALL_LIMIT", 50);
const CLASSIFY_ALL_DELAY_MS = parseEnvInt("XHS_CLASSIFY_ALL_DELAY_MS", 500);
const CLASSIFY_ALL_CONCURRENCY = parseEnvInt("XHS_CLASSIFY_ALL_CONCURRENCY", 5);
const TAXONOMY_LEVEL_NAMES = ["大类", "领域", "主题", "场景", "细项"];
const DEFAULT_TAXONOMY_PATHS = [
  ["美食", "咖啡甜品"],
  ["美食", "餐厅探店"],
  ["穿搭", "日常穿搭"],
  ["美妆", "护肤彩妆"],
  ["旅行", "攻略目的地"],
  ["家居", "装修收纳"],
  ["健康", "运动健身"],
  ["学习", "知识成长"],
  ["科技", "数码工具"],
  ["科技", "AI工具"],
  ["金融", "股票基金"],
  ["金融", "宏观财经"],
  ["安全", "法律证件"],
  ["情感", "家庭关系"],
  ["生活", "母婴亲子"],
  ["生活", "宠物日常"],
  ["生活", "日常记录"]
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseEnvInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function loadDb() {
  const db = readJson(dbPath, { notes: {}, settings: {}, events: [] });
  let migrated = false;
  for (const note of Object.values(db.notes || {})) {
    const normalizedUrl = sourceUrlWithToken(note.url || "", note.xsecToken || "");
    if (normalizedUrl && normalizedUrl !== note.url) {
      note.url = normalizedUrl;
      migrated = true;
    }
  }
  const ai = db.settings && db.settings.ai;
  if (ai && ai.apiKey && !ai.apiKeyProtected && process.platform === "win32") {
    try {
      db.settings = protectStoredSettings(db.settings, { ai: { apiKey: ai.apiKey } }, false);
      migrated = true;
    } catch {
      // Legacy key remains usable if OS protection is temporarily unavailable.
    }
  }
  if (migrated) writeJson(dbPath, db);
  return db;
}

function saveDb(db) {
  writeJson(dbPath, db);
}

function logEvent(db, level, message, meta = {}) {
  db.events.push({
    ts: new Date().toISOString(),
    level,
    message,
    meta
  });
  db.events = db.events.slice(-500);
}

async function handleMessage(message) {
  const type = message && message.type;
  if (!type) return { ok: false, error: "missing_type" };

  if (type === "ping") {
    return { ok: true, archiveRoot };
  }

  const db = loadDb();

  if (type === "upsertNotes") {
    const notes = Array.isArray(message.notes) ? message.notes : [];
    const upserted = [];
    for (const note of notes) {
      const merged = mergeNote(db.notes[note.noteId], note);
      merged.status = noteCompleteness(merged);
      db.notes[merged.noteId] = merged;
      upserted.push(merged.noteId);
    }
    logEvent(db, "info", "upsert_notes", { count: upserted.length });
    saveDb(db);
    return { ok: true, upserted };
  }

  if (type === "listNotes") {
    const notes = Object.values(db.notes)
      .map((note) => ({ ...note, status: noteCompleteness(note) }))
      .sort(compareNotesByDiscoveryOrder);
    return { ok: true, notes };
  }

  if (type === "archiveNote") {
    const noteId = message.noteId;
    const note = db.notes[noteId];
    if (!note) return { ok: false, error: "note_not_found" };
    if (!canArchiveNote(note)) {
      logEvent(db, "warn", "archive_blocked_incomplete", { noteId });
      saveDb(db);
      return { ok: false, error: "content_not_captured", noteId };
    }
    const mediaResult = await archiveMedia(note);
    Object.assign(note, mediaResult.notePatch);
    const rawAi = message.ai || await buildAi(note, db.settings, db.taxonomy);
    const ai = governClassification(db, rawAi, { source: rawAi.source || "archive", noteId: note.noteId });
    const basename = sanitizeFilename(ai.filename || summarizeForFilename(note), "xhs-note");
    const filename = `${basename}-${note.noteId}.md`;
    const notesDir = path.join(archiveRoot, "notes");
    ensureDir(notesDir);
    const markdownPath = path.join(notesDir, filename);
    fs.writeFileSync(markdownPath, renderMarkdown(note, ai), "utf8");
    note.markdownPath = markdownPath;
    note.ai = ai;
    note.status = noteCompleteness(note);
    note.updatedAt = new Date().toISOString();
    db.notes[note.noteId] = note;
    logEvent(db, "info", "archive_note", { noteId: note.noteId, markdownPath });
    saveDb(db);
    return { ok: true, note };
  }

  if (type === "classifyNote") {
    const noteId = message.noteId;
    const note = db.notes[noteId];
    if (!note) return { ok: false, error: "note_not_found" };
    const ai = await buildAi(note, db.settings, db.taxonomy);
    const governed = governClassification(db, ai, { source: ai.source || "ai", noteId: note.noteId });
    note.ai = { ...(note.ai || {}), ...governed };
    note.updatedAt = new Date().toISOString();
    db.notes[note.noteId] = note;
    logEvent(db, "info", "classify_note", { noteId: note.noteId, category: governed.category, subcategory: governed.subcategory });
    saveDb(db);
    return { ok: true, note };
  }

  if (type === "classifyAll") {
    const limit = Math.max(1, Math.min(Number(message.limit) || CLASSIFY_ALL_LIMIT, CLASSIFY_ALL_LIMIT));
    const concurrency = Math.max(1, Math.min(Number(message.concurrency) || CLASSIFY_ALL_CONCURRENCY || 1, 8));
    const notes = Object.values(db.notes || {})
      .filter((note) => note.noteId && !note.unavailableReason)
      .filter((note) => message.force ? true : needsClassification(note))
      .sort(compareNotesByDiscoveryOrder)
      .slice(0, limit);
    const results = new Array(notes.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < notes.length) {
        const index = cursor;
        cursor += 1;
        if (concurrency === 1 && index > 0 && CLASSIFY_ALL_DELAY_MS > 0) await sleep(CLASSIFY_ALL_DELAY_MS);
        const note = notes[index];
        try {
          const ai = await buildAi(note, db.settings, db.taxonomy);
          const governed = governClassification(db, ai, { source: ai.source || "ai", noteId: note.noteId });
          note.ai = { ...(note.ai || {}), ...governed };
          note.updatedAt = new Date().toISOString();
          db.notes[note.noteId] = note;
          results[index] = { noteId: note.noteId, ok: true, category: governed.category, subcategory: governed.subcategory, categoryPath: governed.categoryPath };
        } catch (error) {
          results[index] = { noteId: note.noteId, ok: false, error: error.message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, notes.length) }, () => worker()));
    logEvent(db, "info", "classify_all", { count: results.length, ok: results.filter((item) => item && item.ok).length, concurrency });
    saveDb(db);
    return { ok: true, results };
  }

  if (type === "updateClassification") {
    const noteId = message.noteId;
    const note = db.notes[noteId];
    if (!note) return { ok: false, error: "note_not_found" };
    const patch = governClassification(db, normalizeClassification(message.classification || {}), { source: "manual" });
    note.ai = { ...(note.ai || {}), ...patch, source: "manual" };
    note.updatedAt = new Date().toISOString();
    db.notes[note.noteId] = note;
    logEvent(db, "info", "update_classification", { noteId, category: patch.category, subcategory: patch.subcategory });
    saveDb(db);
    return { ok: true, note };
  }

  if (type === "getTaxonomy") {
    return { ok: true, taxonomy: publicTaxonomy(db) };
  }

  if (type === "mergeTaxonomy") {
    const from = normalizeCategoryPath(message.from);
    const to = normalizeCategoryPath(message.to);
    if (!from.length || !to.length) return { ok: false, error: "missing_taxonomy_path" };
    const result = mergeTaxonomyPath(db, from, to);
    if (result.error) return { ok: false, ...result };
    logEvent(db, "info", "merge_taxonomy", result);
    saveDb(db);
    return { ok: true, ...result, taxonomy: publicTaxonomy(db) };
  }

  if (type === "approveTaxonomyPath") {
    const result = approveTaxonomyPath(db, { key: message.key || "", path: message.path || "" });
    if (!result.approved) return { ok: false, ...result };
    logEvent(db, "info", "approve_taxonomy_path", result);
    saveDb(db);
    return { ok: true, ...result, taxonomy: publicTaxonomy(db) };
  }

  if (type === "rejectPendingTaxonomy") {
    const result = rejectPendingTaxonomy(db, { key: message.key || "", path: message.path || "" });
    if (!result.rejected) return { ok: false, ...result };
    logEvent(db, "info", "reject_pending_taxonomy", result);
    saveDb(db);
    return { ok: true, ...result, taxonomy: publicTaxonomy(db) };
  }

  if (type === "lockTaxonomy") {
    const path = normalizeCategoryPath(message.path);
    if (!path.length) return { ok: false, error: "missing_taxonomy_path" };
    const entry = registerTaxonomyPath(db, normalizeSynonymPath(path), { source: "manual", locked: true, alias: path });
    logEvent(db, "info", "lock_taxonomy", { path: entry.path });
    saveDb(db);
    return { ok: true, entry, taxonomy: publicTaxonomy(db) };
  }

  if (type === "deleteLocal") {
    const ids = Array.isArray(message.noteIds) ? message.noteIds : [];
    for (const id of ids) {
      deleteNoteFiles(db.notes[id]);
      delete db.notes[id];
    }
    logEvent(db, "info", "delete_local", { count: ids.length });
    saveDb(db);
    return { ok: true, deleted: ids };
  }

  if (type === "readLocalMedia") {
    return readLocalMedia(message.file);
  }

  if (type === "saveSettings") {
    try {
      db.settings = protectStoredSettings(db.settings, message.settings || {}, Boolean(message.clearAiKey));
      saveDb(db);
      return { ok: true, settings: publicSettings(db.settings) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  if (type === "getSettings") {
    return { ok: true, settings: publicSettings(db.settings) };
  }

  if (type === "saveManualXhsValidation") {
    const prerequisites = manualValidationPrerequisites(db);
    if (!prerequisites.ok) {
      logEvent(db, "warn", "manual_xhs_validation_blocked", prerequisites);
      saveDb(db);
      return {
        ok: false,
        error: "manual_validation_prerequisites_missing",
        prerequisites
      };
    }
    const validation = normalizeManualXhsValidation(message.validation || {});
    db.manualXhsValidation = validation;
    logEvent(db, "info", "manual_xhs_validation_saved", {
      recordedAt: validation.recordedAt,
      passed: validation.passed
    });
    saveDb(db);
    return { ok: true, validation };
  }

  if (type === "testAiProvider") {
    const result = await testAiProvider(db.settings);
    logEvent(db, result.ok ? "info" : "error", "test_ai_provider", { ok: result.ok, error: result.error || "" });
    saveDb(db);
    return result;
  }

  if (type === "getReport") {
    return {
      ok: true,
      report: buildReport(db)
    };
  }

  if (type === "getInsights") {
    return {
      ok: true,
      insights: buildInsights(db)
    };
  }

  if (type === "exportAll") {
    const result = exportAll(db);
    logEvent(db, "info", "export_all", result);
    saveDb(db);
    return { ok: true, ...result };
  }

  if (type === "exportSelfTest") {
    const result = exportSelfTest(db);
    logEvent(db, "info", "export_self_test", result);
    saveDb(db);
    return { ok: true, ...result };
  }

  return { ok: false, error: `unknown_type:${type}` };
}

function buildLocalAiFallback(note) {
  const title = normalizeAiText(note.title || note.noteId || "");
  const taxonomy = inferTaxonomy(note);
  const tags = Array.from(new Set(taxonomy.path.filter((item) => item && item !== "未分类" && item !== "待细分")));
  return {
    category: taxonomy.path[0] || "未分类",
    subcategory: taxonomy.path[1] || "待细分",
    categoryPath: taxonomy.path,
    tags,
    summary: title ? `按标题和封面归入${taxonomy.path.join("/")}：${title}` : "标题缺失，仅按封面线索待整理。",
    highlights: note.cover ? `封面：${note.cover}` : "封面缺失。",
    filename: summarizeForFilename(note),
    source: "local"
  };
}

function normalizeAiText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAiText(item)).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value || "").trim();
}

function buildReport(db) {
  const notes = Object.values(db.notes || {});
  const counts = {};
  for (const note of notes) {
    const status = noteCompleteness(note);
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    archiveRoot,
    total: notes.length,
    counts,
    events: (db.events || []).slice(-20)
  };
}

function buildInsights(db) {
  const notes = Object.values(db.notes || {});
  const categories = countBy(notes, (note) => classificationOf(note).category);
  const subcategories = countBy(notes, (note) => classificationOf(note).path.slice(0, 2).join("/"));
  const categoryPaths = countBy(notes, (note) => classificationOf(note).path.join("/"));
  const statuses = countBy(notes, (note) => noteCompleteness(note));
  const tags = {};
  for (const note of notes) {
    for (const tag of note.ai && note.ai.tags || note.tags || []) {
      tags[tag] = (tags[tag] || 0) + 1;
    }
  }
  const topCategories = topEntries(categories, 6);
  const topTags = topEntries(tags, 12);
  const archived = notes.filter((note) => noteCompleteness(note) === "archived").length;
  const captured = notes.filter((note) => note.text || (note.images || []).length || (note.videos || []).length).length;
  return {
    total: notes.length,
    archived,
    captured,
    categories,
    subcategories,
    categoryPaths,
    statuses,
    topCategories,
    topTags,
    persona: buildPersona(notes, topCategories, topTags),
    receipt: buildReceipt(notes, topCategories, statuses),
    achievements: buildAchievements(notes, categories, statuses, topTags)
  };
}

function buildPersona(notes, topCategories, topTags) {
  const main = topCategories[0] && topCategories[0].name || "未分类";
  const second = topCategories[1] && topCategories[1].name || "探索中";
  const tagLine = topTags.slice(0, 3).map((item) => item.name).join(" / ") || "暂无标签";
  const archivedRatio = notes.length ? Math.round(notes.filter((note) => noteCompleteness(note) === "archived").length / notes.length * 100) : 0;
  return {
    name: `${main}收藏体质`,
    title: `${main}优先，${second}备选`,
    tagline: tagLine,
    description: `共 ${notes.length} 条，本地归档率 ${archivedRatio}%。偏好集中在 ${main}，常见标签：${tagLine}。`
  };
}

function buildReceipt(notes, topCategories, statuses) {
  return {
    title: "收藏成分表",
    total: notes.length,
    lines: topCategories.map((item) => ({
      label: item.name,
      count: item.count,
      percent: notes.length ? Math.round(item.count / notes.length * 100) : 0
    })),
    statuses
  };
}

function exportAll(db) {
  const exportDir = path.join(archiveRoot, "exports");
  ensureDir(exportDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const notes = Object.values(db.notes || {});
  const insights = buildInsights(db);
  const jsonPath = path.join(exportDir, `xhs-archive-${stamp}.json`);
  const indexPath = path.join(exportDir, `xhs-archive-index-${stamp}.md`);
  const csvPath = path.join(exportDir, `xhs-archive-notion-${stamp}.csv`);
  const jsonlPath = path.join(exportDir, `xhs-archive-ai-kb-${stamp}.jsonl`);
  writeJson(jsonPath, { exportedAt: new Date().toISOString(), notes, insights });
  fs.writeFileSync(indexPath, renderIndexMarkdown(notes, insights), "utf8");
  fs.writeFileSync(csvPath, renderNotionCsv(notes), "utf8");
  fs.writeFileSync(jsonlPath, renderAiKnowledgeJsonl(notes), "utf8");
  return { jsonPath, indexPath, csvPath, jsonlPath, count: notes.length };
}

function exportSelfTest(db) {
  const exportDir = path.join(archiveRoot, "exports");
  ensureDir(exportDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(exportDir, `xhs-archive-self-test-${stamp}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    archiveRoot,
    databasePath: dbPath,
    report: buildReport(db),
    insights: buildInsights(db),
    manualXhsValidation: db.manualXhsValidation || null,
    checks: {
      archiveRootExists: fs.existsSync(archiveRoot),
      databaseExists: fs.existsSync(dbPath),
      notesDirExists: fs.existsSync(path.join(archiveRoot, "notes")),
      exportsDirExists: fs.existsSync(exportDir)
    },
    acceptanceChecklist: buildAcceptanceChecklist(db),
    manualXhsChecklist: buildManualXhsChecklist(db)
  };
  writeJson(file, payload);
  return { selfTestPath: file };
}

function buildManualXhsChecklist(db) {
  const report = buildReport(db);
  const validation = db.manualXhsValidation || {};
  const checklist = [
    { id: "logged_in", label: "已在浏览器正常登录小红书网页端", requiresUserVerification: true, pass: null },
    { id: "opened_favorites_or_likes", label: "已打开收藏/点赞页并由用户触发采集或受控扫描", pass: report.total > 0 },
    { id: "no_access_warning", label: "扫描过程中未出现扫码、验证、频繁访问或访问受限提示", requiresUserVerification: true, pass: null },
    { id: "controlled_scan_used", label: "自动滚动使用受控扫描，或手动滚动后点击采集当前", requiresUserVerification: true, pass: null },
    { id: "title_cover_only", label: "分类只使用收藏卡片标题与封面，不打开帖子补全正文或评论", requiresUserVerification: true, pass: null },
    { id: "classified", label: "至少一条收藏卡片已生成五层以内分类路径", pass: classifiedNotes(db).length > 0 },
    { id: "markdown_archived", label: "至少一条收藏卡片已导出 Markdown", pass: (report.counts.archived || 0) > 0 }
  ];
  if (!validation.passed) return checklist;
  return checklist.map((item) => {
    if (!item.requiresUserVerification) return item;
    return {
      ...item,
      pass: true,
      recordedAt: validation.recordedAt,
      source: validation.source || "sidepanel"
    };
  });
}

function normalizeManualXhsValidation(validation) {
  return {
    passed: Boolean(validation.passed),
    source: String(validation.source || "sidepanel").slice(0, 80),
    recordedAt: new Date().toISOString(),
    note: String(validation.note || "").slice(0, 500)
  };
}

function manualValidationPrerequisites(db) {
  const report = buildReport(db);
  const classified = classifiedNotes(db).length > 0;
  const markdownArchived = (report.counts.archived || 0) > 0;
  return {
    ok: report.total > 0 && classified && markdownArchived,
    notesSeen: report.total > 0,
    classified,
    markdownArchived
  };
}

function classifiedNotes(db) {
  return Object.values(db.notes || {}).filter((note) => {
    const ai = note.ai || {};
    return normalizeCategoryPath(ai.categoryPath || [ai.category, ai.subcategory]).length > 0;
  });
}

function buildAcceptanceChecklist(db) {
  const report = buildReport(db);
  return [
    { id: "native_host", label: "Native Host 可通信", pass: true },
    { id: "archive_root", label: "归档目录可写", pass: fs.existsSync(archiveRoot) },
    { id: "database", label: "数据库可读写", pass: fs.existsSync(dbPath) },
    { id: "notes_seen", label: "已发现至少一条笔记", pass: report.total > 0 },
    { id: "markdown_written", label: "已写入至少一份 Markdown", pass: (report.counts.archived || 0) > 0 },
    { id: "safe_events", label: "最近事件可追踪", pass: Array.isArray(db.events) },
    { id: "export_ready", label: "导出目录可用", pass: fs.existsSync(path.join(archiveRoot, "exports")) }
  ];
}

function renderIndexMarkdown(notes, insights) {
  const lines = [
    "# 小红书本地归档索引",
    "",
    `导出时间：${new Date().toISOString()}`,
    `总数：${notes.length}`,
    `人格卡：${insights.persona.name}`,
    "",
    "## 成分表",
    "",
    ...insights.receipt.lines.map((line) => `- ${line.label}: ${line.count} (${line.percent}%)`),
    "",
    "## 笔记",
    ""
  ];
  for (const note of notes) {
    const cls = classificationOf(note);
    lines.push(`- [${note.title || note.noteId}](${note.markdownPath || note.url || ""}) - ${cls.category} / ${cls.subcategory}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderNotionCsv(notes) {
  const rows = [
    ["Title", "URL", "Author", "Category", "Subcategory", "Tags", "Status", "MarkdownPath", "Summary", "Highlights"]
  ];
  for (const note of notes) {
    const cls = classificationOf(note);
    rows.push([
      note.title || note.noteId || "",
      note.url || "",
      note.author || "",
      cls.category,
      cls.subcategory,
      (note.ai && note.ai.tags || note.tags || []).join("; "),
      noteCompleteness(note),
      note.markdownPath || "",
      note.ai && note.ai.summary || note.summary || "",
      note.ai && note.ai.highlights || note.highlights || ""
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderAiKnowledgeJsonl(notes) {
  return notes.map((note) => JSON.stringify({
    id: note.noteId,
    title: note.title || "",
    url: note.url || "",
    author: note.author || "",
    category: classificationOf(note).category,
    subcategory: classificationOf(note).subcategory,
    tags: note.ai && note.ai.tags || note.tags || [],
    text: note.text || "",
    summary: note.ai && note.ai.summary || "",
    highlights: note.ai && note.ai.highlights || note.highlights || "",
    comments: note.comments || [],
    markdownPath: note.markdownPath || "",
    status: noteCompleteness(note)
  })).join("\n") + "\n";
}

function csvCell(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function buildAchievements(notes, categories, statuses, topTags) {
  const total = notes.length;
  const archived = statuses.archived || 0;
  const captured = (statuses["content-captured"] || 0) + (statuses["comments-captured"] || 0) + archived;
  const comments = notes.reduce((sum, note) => sum + (note.comments || []).length, 0);
  const media = notes.reduce((sum, note) => sum + (note.images || []).length + (note.videos || []).length + (note.cover ? 1 : 0), 0);
  const unlocked = new Set();

  unlockAt(unlocked, "first_note", total >= 1);
  unlockAt(unlocked, "ten_notes", total >= 10);
  unlockAt(unlocked, "thirty_notes", total >= 30);
  unlockAt(unlocked, "hundred_notes", total >= 100);
  unlockAt(unlocked, "first_archive", archived >= 1);
  unlockAt(unlocked, "ten_archives", archived >= 10);
  unlockAt(unlocked, "archive_half", total > 0 && archived / total >= 0.5);
  unlockAt(unlocked, "archive_all", total > 0 && archived === total);
  unlockAt(unlocked, "content_hunter", captured >= 10);
  unlockAt(unlocked, "comment_reader", comments >= 10);
  unlockAt(unlocked, "comment_collector", comments >= 50);
  unlockAt(unlocked, "media_collector", media >= 20);
  unlockAt(unlocked, "tag_starter", topTags.length >= 1);
  unlockAt(unlocked, "tag_cloud", topTags.length >= 8);
  unlockAt(unlocked, "food_mode", (categories["美食"] || 0) >= 3);
  unlockAt(unlocked, "style_mode", (categories["穿搭"] || 0) >= 3);
  unlockAt(unlocked, "travel_mode", (categories["旅行"] || 0) >= 3);
  unlockAt(unlocked, "tech_mode", (categories["科技"] || 0) >= 3);
  unlockAt(unlocked, "mixed_taste", Object.keys(categories).length >= 4);
  unlockAt(unlocked, "deep_library", total >= 50 && archived >= 25);
  unlockAt(unlocked, "local_first", archived >= 5 && total > 0);
  unlockAt(unlocked, "comment_plus", notes.some((note) => (note.comments || []).length >= 5));
  unlockAt(unlocked, "video_seen", notes.some((note) => (note.videos || []).length > 0));
  unlockAt(unlocked, "image_seen", notes.some((note) => (note.images || []).length > 0 || note.cover));
  unlockAt(unlocked, "summary_ready", notes.some((note) => note.ai && note.ai.summary));
  unlockAt(unlocked, "category_ready", Object.keys(categories).some((key) => key !== "未分类"));
  unlockAt(unlocked, "export_ready", archived >= 1);
  unlockAt(unlocked, "rescue_started", (statuses.discovered || 0) > 0);
  unlockAt(unlocked, "knowledge_base_seed", captured >= 3);
  unlockAt(unlocked, "power_user", total >= 100 && archived >= 50);

  return ACHIEVEMENTS.map((achievement) => ({
    ...achievement,
    unlocked: unlocked.has(achievement.id)
  }));
}

function unlockAt(set, id, condition) {
  if (condition) set.add(id);
}

const ACHIEVEMENTS = [
  ["first_note", "第一枚收藏"],
  ["ten_notes", "十连发现"],
  ["thirty_notes", "收藏热身"],
  ["hundred_notes", "收藏仓库"],
  ["first_archive", "第一份归档"],
  ["ten_archives", "归档十连"],
  ["archive_half", "半壁江山"],
  ["archive_all", "全员上岸"],
  ["content_hunter", "内容猎手"],
  ["comment_reader", "评论读者"],
  ["comment_collector", "评论矿工"],
  ["media_collector", "素材仓管"],
  ["tag_starter", "标签开张"],
  ["tag_cloud", "标签云成形"],
  ["food_mode", "美食雷达"],
  ["style_mode", "穿搭雷达"],
  ["travel_mode", "旅行雷达"],
  ["tech_mode", "科技雷达"],
  ["mixed_taste", "多面收藏家"],
  ["deep_library", "深度知识库"],
  ["local_first", "本地优先"],
  ["comment_plus", "热评捕手"],
  ["video_seen", "视频入库"],
  ["image_seen", "图像入库"],
  ["summary_ready", "摘要点亮"],
  ["category_ready", "分类点亮"],
  ["export_ready", "导出就绪"],
  ["rescue_started", "收藏复活开始"],
  ["knowledge_base_seed", "知识库种子"],
  ["power_user", "重度整理师"]
].map(([id, title]) => ({ id, title }));

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item) || "未分类";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topEntries(counts, limit) {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function compareNotesByDiscoveryOrder(a, b) {
  const aIndex = Number(a.discoveryIndex);
  const bIndex = Number(b.discoveryIndex);
  if (Number.isFinite(aIndex) && Number.isFinite(bIndex) && aIndex !== bIndex) return aIndex - bIndex;
  if (Number.isFinite(aIndex) !== Number.isFinite(bIndex)) return Number.isFinite(aIndex) ? -1 : 1;
  const aTime = String(a.createdAt || a.updatedAt || "");
  const bTime = String(b.createdAt || b.updatedAt || "");
  return aTime.localeCompare(bTime) || String(a.noteId || "").localeCompare(String(b.noteId || ""));
}

function classificationOf(note) {
  const ai = note.ai || {};
  const cls = normalizeClassification({
    categoryPath: ai.categoryPath,
    category: ai.category,
    subcategory: ai.subcategory,
    tags: ai.tags
  }, inferTaxonomy(note));
  return {
    ...cls,
    category: cls.path[0] || "未分类",
    subcategory: cls.path[1] || "待细分"
  };
}

function classificationKey(note) {
  return classificationOf(note).path.join("/");
}

function needsClassification(note) {
  const ai = note && note.ai || {};
  if (!ai || !Object.keys(ai).length) return true;
  if (ai.providerError) return true;
  if (ai.source === "manual" || ai.source === "merge") return false;
  if (ai.taxonomyPending) return false;
  const path = normalizeCategoryPath(ai.categoryPath || [ai.category, ai.subcategory]);
  if (!path.length) return true;
  return pathKey(path) === "未分类/待细分" && !ai.summary && !ai.aiPipeline;
}

function normalizeClassification(value = {}, fallback = { path: ["未分类", "待细分"] }) {
  const fallbackPath = normalizeCategoryPath(fallback.path || [fallback.category, fallback.subcategory]);
  const suppliedPath = normalizeCategoryPath(value.categoryPath || value.path || value.categories);
  const legacyPath = normalizeCategoryPath([
    value.category,
    value.subcategory || value.subCategory || value.minorCategory
  ]);
  const path = suppliedPath.length ? suppliedPath : legacyPath.length ? legacyPath : fallbackPath;
  const normalizedPath = path.length ? path : ["未分类", "待细分"];
  return {
    path: normalizedPath,
    categoryPath: normalizedPath,
    category: normalizedPath[0] || "未分类",
    subcategory: normalizedPath[1] || "待细分",
    tags: Array.isArray(value.tags) ? value.tags.map(normalizeAiText).filter(Boolean).slice(0, 12) : []
  };
}

function normalizeCategoryPath(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/[/>｜|,，]/);
  return raw
    .map((item) => normalizeAiText(item).replace(/^#+/, "").trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((item) => item.slice(0, 40));
}

function normalizeSynonymPath(path) {
  const normalized = normalizeCategoryPath(path);
  if (!normalized.length) return normalized;
  const top = normalized[0].replace(/\s+/g, "");
  const topMap = new Map([
    ["餐饮", "美食"],
    ["吃喝", "美食"],
    ["吃喝玩乐", "美食"],
    ["探店", "美食"],
    ["美食探店", "美食"],
    ["咖啡", "美食"],
    ["甜品", "美食"],
    ["时尚", "穿搭"],
    ["服饰", "穿搭"],
    ["搭配", "穿搭"],
    ["护肤", "美妆"],
    ["彩妆", "美妆"],
    ["出行", "旅行"],
    ["旅游", "旅行"],
    ["装修", "家居"],
    ["数码科技", "科技"],
    ["工具", "科技"],
    ["运动", "健康"]
  ]);
  if (topMap.has(top)) return [topMap.get(top), ...normalized.slice(1)].slice(0, 5);
  return normalized;
}

function pathKey(path) {
  return normalizeCategoryPath(path).join("/");
}

function pathToken(path) {
  return pathKey(path).toLowerCase().replace(/\s+/g, "");
}

function pathStartsWithPath(path, prefix) {
  return prefix.every((item, index) => path[index] === item);
}

function publicTaxonomy(db) {
  syncTaxonomyCounts(db);
  const taxonomy = taxonomyState(db);
  const nodes = taxonomy.nodes
    .filter((node) => node.approved !== false)
    .slice()
    .sort((a, b) => a.level - b.level || pathKey(a.path).localeCompare(pathKey(b.path)));
  const entries = deriveTaxonomyEntries(db, nodes)
    .sort((a, b) => (b.count || 0) - (a.count || 0) || pathKey(a.path).localeCompare(pathKey(b.path)));
  return {
    levelNames: TAXONOMY_LEVEL_NAMES.slice(),
    nodes,
    pendingNodes: taxonomy.pendingNodes.filter((item) => item.status === "pending"),
    entries,
    merges: (taxonomy.merges || []).slice(-100)
  };
}

function syncTaxonomyCounts(db) {
  const taxonomy = taxonomyState(db);
  const prefixCounts = {};
  for (const note of Object.values(db.notes || {})) {
    const path = classificationOf(note).categoryPath;
    for (let index = 1; index <= path.length; index += 1) {
      const key = pathKey(path.slice(0, index));
      prefixCounts[key] = (prefixCounts[key] || 0) + 1;
    }
  }
  for (const node of taxonomy.nodes) {
    node.count = prefixCounts[pathKey(node.path)] || 0;
  }
}

function registerTaxonomyPath(db, path, options = {}) {
  const node = ensureApprovedPath(db, path, options);
  syncTaxonomyCounts(db);
  return node ? nodeToEntry(node) : null;
}

function canonicalizeCategoryPath(db, path) {
  return resolveControlledPath(db, path, { source: "canonicalize" }).path;
}

function governClassification(db, classification, options = {}) {
  const normalized = normalizeClassification(classification || {});
  const source = options.source || normalized.source || "auto";
  const resolved = resolveControlledPath(db, normalized.categoryPath, { source, noteId: options.noteId });
  const canonicalPath = resolved.path;
  return {
    ...(classification || {}),
    ...normalized,
    categoryPath: canonicalPath,
    path: canonicalPath,
    category: canonicalPath[0] || "未分类",
    subcategory: canonicalPath[1] || "待细分",
    taxonomyKey: pathKey(canonicalPath),
    taxonomyLocked: Boolean(resolved.node && resolved.node.locked),
    taxonomyPending: Boolean(resolved.pending),
    taxonomyPendingKey: resolved.pendingKey || "",
    proposedCategoryPath: resolved.proposedPath || [],
    source
  };
}

function mergeTaxonomyPath(db, fromPath, toPath) {
  const taxonomy = taxonomyState(db);
  const fromAlias = normalizeCategoryPath(fromPath);
  const from = findApprovedPathByAlias(db, fromAlias) || normalizeSynonymPath(fromAlias);
  const to = normalizeSynonymPath(normalizeCategoryPath(toPath));
  if (pathKey(from) === pathKey(to)) return { from, to, changed: 0, error: "same_taxonomy_path" };
  if (pathStartsWithPath(to, from)) return { from, to, changed: 0, error: "taxonomy_merge_cycle" };
  const descendants = taxonomy.nodes
    .filter((node) => node.approved !== false && node.path.length > from.length && pathStartsWithPath(node.path, from))
    .map((node) => ({ suffix: node.path.slice(from.length), locked: node.locked, aliases: node.pathAliases || [] }));
  const toNode = ensureApprovedPath(db, to, { source: "manual", alias: fromAlias });
  for (const descendant of descendants) {
    const node = ensureApprovedPath(db, [...to, ...descendant.suffix].slice(0, 5), { source: "merge", locked: descendant.locked });
    if (node) node.pathAliases = Array.from(new Set([...(node.pathAliases || []), ...descendant.aliases]));
  }
  let changed = 0;
  for (const note of Object.values(db.notes || {})) {
    const current = classificationOf(note).categoryPath;
    if (pathStartsWithPath(current, from)) {
      const next = [...to, ...current.slice(from.length)].slice(0, 5);
      note.ai = { ...(note.ai || {}), ...governClassification(db, { ...(note.ai || {}), categoryPath: next }, { source: "merge" }) };
      note.updatedAt = new Date().toISOString();
      changed += 1;
    }
  }
  const fromNode = findNodeByPath(db, from);
  if (fromNode && toNode && fromNode.key !== toNode.key) {
    toNode.pathAliases = Array.from(new Set([...(toNode.pathAliases || []), pathKey(fromAlias), pathKey(from), ...(fromNode.pathAliases || [])].filter(Boolean)));
    for (const node of taxonomy.nodes) {
      if (pathStartsWithPath(node.path, from)) {
        node.approved = false;
        node.updatedAt = new Date().toISOString();
      }
    }
  }
  taxonomy.merges.push({ from, to, changed, mergedAt: new Date().toISOString() });
  syncTaxonomyCounts(db);
  return { from, to, changed };
}

function taxonomyState(db) {
  if (!db.taxonomy || typeof db.taxonomy !== "object") db.taxonomy = {};
  const taxonomy = db.taxonomy;
  if (!Array.isArray(taxonomy.entries)) taxonomy.entries = [];
  if (!Array.isArray(taxonomy.nodes)) taxonomy.nodes = [];
  if (!Array.isArray(taxonomy.pendingNodes)) taxonomy.pendingNodes = [];
  if (!Array.isArray(taxonomy.merges)) taxonomy.merges = [];
  if (!taxonomy.nodeModelVersion) {
    const legacyEntries = taxonomy.entries.slice();
    taxonomy.nodeModelVersion = 1;
    taxonomy._ensuringBase = true;
    for (const entry of legacyEntries) {
      const node = ensureApprovedPath(db, entry.path, {
        source: entry.source || "legacy",
        locked: Boolean(entry.locked)
      });
      if (node) {
        node.pathAliases = Array.from(new Set([...(node.pathAliases || []), ...(entry.aliases || [])]));
      }
    }
    delete taxonomy._ensuringBase;
  }
  if (!taxonomy.nodes.some((node) => node.approved !== false && pathKey(node.path) === "未分类/待细分") && !taxonomy._ensuringBase) {
    taxonomy._ensuringBase = true;
    ensureApprovedPath(db, ["未分类", "待细分"], { source: "system", locked: true });
    delete taxonomy._ensuringBase;
  }
  if (taxonomy.defaultSeedVersion !== 1 && !taxonomy._ensuringBase) {
    taxonomy._ensuringBase = true;
    for (const path of DEFAULT_TAXONOMY_PATHS) {
      ensureApprovedPath(db, [path[0]], { source: "system", locked: true });
      ensureApprovedPath(db, path, { source: "system" });
    }
    taxonomy.defaultSeedVersion = 1;
    delete taxonomy._ensuringBase;
  }
  return taxonomy;
}

function nodeKey(parentKey, name) {
  return crypto
    .createHash("sha1")
    .update(`${parentKey || "root"}\n${pathToken([name])}`)
    .digest("hex")
    .slice(0, 18);
}

function segmentToken(value) {
  return pathToken([value]);
}

function findChildNode(taxonomy, parentKey, name) {
  const token = segmentToken(name);
  return taxonomy.nodes.find((node) =>
    node.approved !== false &&
    (node.parentKey || "") === (parentKey || "") &&
    (segmentToken(node.name) === token || (node.aliases || []).some((alias) => segmentToken(alias) === token))
  );
}

function findNodeByPath(db, path) {
  const key = pathKey(path);
  return taxonomyState(db).nodes.find((node) => node.approved !== false && pathKey(node.path) === key) || null;
}

function findApprovedPathByAlias(db, path) {
  const normalized = normalizeCategoryPath(path);
  const token = pathToken(normalized);
  const node = taxonomyState(db).nodes.find((item) =>
    item.approved !== false &&
    (pathToken(item.path) === token || (item.pathAliases || []).some((alias) => pathToken(alias) === token))
  );
  return node ? node.path.slice() : null;
}

function ensureApprovedPath(db, path, options = {}) {
  const taxonomy = taxonomyState(db);
  const original = normalizeCategoryPath(path);
  const normalized = normalizeSynonymPath(original);
  if (!normalized.length) return null;
  let parentKey = "";
  let currentPath = [];
  let node = null;
  const now = new Date().toISOString();
  for (const name of normalized) {
    currentPath = [...currentPath, name].slice(0, 5);
    const key = nodeKey(parentKey, name);
    node = taxonomy.nodes.find((item) => item.key === key);
    if (!node) {
      node = {
        key,
        name,
        level: currentPath.length,
        parentKey,
        path: currentPath.slice(),
        aliases: [],
        pathAliases: [],
        locked: false,
        approved: true,
        source: options.source || "manual",
        count: 0,
        createdAt: now,
        updatedAt: now
      };
      taxonomy.nodes.push(node);
    }
    node.approved = true;
    node.name = node.locked ? node.name : name;
    node.level = currentPath.length;
    node.parentKey = parentKey;
    node.path = currentPath.slice();
    if (options.locked) node.locked = true;
    node.updatedAt = now;
    parentKey = node.key;
  }
  if (node && options.alias) {
    const aliasPath = normalizeCategoryPath(options.alias);
    const aliasKey = pathKey(aliasPath);
    if (aliasKey && aliasKey !== pathKey(node.path)) {
      node.pathAliases = Array.from(new Set([...(node.pathAliases || []), aliasKey]));
    }
    if (aliasPath.length === normalized.length) {
      const aliasName = aliasPath[aliasPath.length - 1];
      if (aliasName && aliasName !== node.name) {
        node.aliases = Array.from(new Set([...(node.aliases || []), aliasName]));
      }
    }
  }
  return node;
}

function resolveControlledPath(db, path, options = {}) {
  const taxonomy = taxonomyState(db);
  const original = normalizeCategoryPath(path);
  const normalized = normalizeSynonymPath(original);
  if (!normalized.length) {
    const fallback = ensureApprovedPath(db, ["未分类", "待细分"], { source: "system", locked: true });
    return { path: fallback.path.slice(), node: fallback };
  }
  const aliasPath = findApprovedPathByAlias(db, original) || findApprovedPathByAlias(db, normalized);
  if (aliasPath) {
    const node = findNodeByPath(db, aliasPath);
    return { path: aliasPath, node };
  }
  if (canCreateApprovedTaxonomy(options.source, taxonomy)) {
    const node = ensureApprovedPath(db, normalized, { source: options.source || "manual", alias: original });
    return { path: node.path.slice(), node };
  }
  let parentKey = "";
  const accepted = [];
  let node = null;
  for (const segment of normalized) {
    node = findChildNode(taxonomy, parentKey, segment);
    if (!node) {
      const pending = addPendingTaxonomyPath(db, normalized, {
        acceptedPath: accepted,
        noteId: options.noteId,
        source: options.source || "ai"
      });
      const fallback = accepted.length
        ? accepted
        : ensureApprovedPath(db, ["未分类", "待细分"], { source: "system", locked: true }).path;
      return {
        path: fallback.slice(),
        node: accepted.length ? findNodeByPath(db, accepted) : findNodeByPath(db, fallback),
        pending: true,
        pendingKey: pending.key,
        proposedPath: normalized
      };
    }
    accepted.push(node.name);
    parentKey = node.key;
  }
  return { path: accepted, node };
}

function canCreateApprovedTaxonomy(source, taxonomy) {
  if (["manual", "merge", "system", "legacy", "local"].includes(source)) return true;
  return false;
}

function addPendingTaxonomyPath(db, path, options = {}) {
  const taxonomy = taxonomyState(db);
  const normalized = normalizeSynonymPath(normalizeCategoryPath(path));
  const key = crypto.createHash("sha1").update(pathKey(normalized)).digest("hex").slice(0, 18);
  let pending = taxonomy.pendingNodes.find((item) => item.key === key && item.status === "pending");
  const now = new Date().toISOString();
  if (!pending) {
    pending = {
      key,
      path: normalized,
      name: normalized[normalized.length - 1] || "",
      level: normalized.length,
      acceptedPath: normalizeCategoryPath(options.acceptedPath || []),
      noteIds: [],
      source: options.source || "ai",
      status: "pending",
      count: 0,
      createdAt: now,
      updatedAt: now
    };
    taxonomy.pendingNodes.push(pending);
  }
  if (options.noteId && !pending.noteIds.includes(options.noteId)) pending.noteIds.push(options.noteId);
  pending.count = pending.noteIds.length;
  pending.updatedAt = now;
  return pending;
}

function approveTaxonomyPath(db, options = {}) {
  const taxonomy = taxonomyState(db);
  const pending = findPendingTaxonomy(taxonomy, options);
  const path = pending ? pending.path : normalizeCategoryPath(options.path);
  if (!path.length) return { approved: false, changed: 0, error: "missing_taxonomy_path" };
  const node = ensureApprovedPath(db, path, { source: "manual" });
  let changed = 0;
  for (const note of Object.values(db.notes || {})) {
    const ai = note.ai || {};
    const samePending = pending && ai.taxonomyPendingKey === pending.key;
    const sameProposal = pathKey(ai.proposedCategoryPath || []) === pathKey(path);
    if (samePending || sameProposal) {
      note.ai = { ...ai, ...governClassification(db, { ...ai, categoryPath: path }, { source: "manual" }), source: ai.source || "ai" };
      note.updatedAt = new Date().toISOString();
      changed += 1;
    }
  }
  if (pending) {
    pending.status = "approved";
    pending.approvedAt = new Date().toISOString();
  }
  syncTaxonomyCounts(db);
  return { approved: true, path: node.path.slice(), changed };
}

function rejectPendingTaxonomy(db, options = {}) {
  const taxonomy = taxonomyState(db);
  const pending = findPendingTaxonomy(taxonomy, options);
  if (!pending) return { rejected: false, error: "pending_taxonomy_not_found" };
  pending.status = "rejected";
  pending.rejectedAt = new Date().toISOString();
  pending.updatedAt = pending.rejectedAt;
  return { rejected: true, path: pending.path.slice(), key: pending.key };
}

function findPendingTaxonomy(taxonomy, options = {}) {
  const key = String(options.key || "");
  const path = normalizeCategoryPath(options.path || []);
  return taxonomy.pendingNodes.find((item) =>
    item.status === "pending" &&
    ((key && item.key === key) || (path.length && pathKey(item.path) === pathKey(path)))
  ) || null;
}

function deriveTaxonomyEntries(db, nodes = null) {
  const taxonomy = taxonomyState(db);
  const approved = nodes || taxonomy.nodes.filter((node) => node.approved !== false);
  const childCounts = {};
  for (const node of approved) {
    if (node.parentKey) childCounts[node.parentKey] = (childCounts[node.parentKey] || 0) + 1;
  }
  return approved
    .filter((node) => node.path.length && ((childCounts[node.key] || 0) === 0 || node.count > 0 || node.locked))
    .map(nodeToEntry);
}

function nodeToEntry(node) {
  return {
    key: node.key,
    path: node.path.slice(),
    aliases: (node.pathAliases || []).slice(),
    locked: Boolean(node.locked),
    approved: node.approved !== false,
    source: node.source || "manual",
    count: node.count || 0,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  };
}

function inferTaxonomy(note) {
  const text = `${note.title || ""} ${note.cover || ""}`.toLowerCase();
  const rules = [
    [/咖啡|甜品|蛋糕|烘焙|奶茶|饮品|tea|coffee|cafe|cake/, ["美食", "咖啡甜品"]],
    [/餐厅|探店|火锅|烧烤|烤肉|日料|西餐|brunch|酒吧|bar/, ["美食", "餐厅探店"]],
    [/菜谱|做法|早餐|晚餐|减脂餐|便当|食谱|recipe/, ["美食", "家常烹饪"]],
    [/穿搭|ootd|搭配|裙|鞋|包|外套|牛仔|通勤|显瘦/, ["穿搭", "日常穿搭"]],
    [/美妆|妆容|口红|粉底|护肤|香水|发型|发色/, ["美妆", "妆容护肤"]],
    [/旅行|旅游|攻略|路线|酒店|民宿|机票|citywalk|露营/, ["旅行", "目的地攻略"]],
    [/家居|装修|收纳|软装|租房|房间|卧室|客厅/, ["家居", "装修收纳"]],
    [/健身|瑜伽|跑步|普拉提|减脂|运动|训练/, ["健康", "运动健身"]],
    [/学习|读书|考研|英语|笔记|效率|自律|课程/, ["学习", "知识成长"]],
    [/大模型|agent|rag|prompt|提示词|ai工具|openai|claude|deepseek|mcp|llm/, ["科技", "AI工具"]],
    [/数码|手机|电脑|软件|app|相机|键盘|耳机/, ["科技", "数码工具"]],
    [/股票|美股|港股|a股|基金|etf|券商|开户|做空|财报|半导体|牛市|熊市|量价|当冲/, ["金融", "股票基金"]],
    [/宏观|美联储|降息|加息|美元|汇率|通胀|经济|财富风口/, ["金融", "宏观财经"]],
    [/身份证|证件|诈骗|防骗|法律|合同|安全|燃气|用电|保命/, ["安全", "法律证件"]],
    [/原生家庭|亲密关系|情绪|心理|分手|婚姻/, ["情感", "家庭关系"]],
    [/母婴|宝宝|儿童|育儿|亲子/, ["生活", "母婴亲子"]],
    [/宠物|猫|狗|猫咪|狗狗/, ["生活", "宠物日常"]]
  ];
  for (const [pattern, path] of rules) {
    if (pattern.test(text)) return { path };
  }
  return { path: ["未分类", "待细分"] };
}

async function buildAi(note, settings = {}, taxonomy = null) {
  const errors = [];
  const textAi = readRuntimeAiSettings(settings, "text", errors);
  const visionAi = readRuntimeAiSettings(settings, "vision", errors);
  if (!isAiConfigured(textAi) && !isAiConfigured(visionAi)) {
    const fallback = buildLocalAiFallback(note);
    if (errors.length) fallback.providerError = errors.join("; ");
    return fallback;
  }
  try {
    if (isAiConfigured(textAi) && isAiConfigured(visionAi)) {
      return await callDualAiCompatible(note, textAi, visionAi, taxonomy);
    }
    if (isAiConfigured(visionAi)) {
      return await callOpenAiCompatible(note, visionAi, taxonomy, { useImage: true, role: "vision" });
    }
    return await callOpenAiCompatible(note, textAi, taxonomy, { useImage: false, role: "text" });
  } catch (error) {
    return {
      ...buildLocalAiFallback(note),
      providerError: error.message
    };
  }
}

async function testAiProvider(settings = {}) {
  const errors = [];
  const textAi = readRuntimeAiSettings(settings, "text", errors);
  const visionAi = readRuntimeAiSettings(settings, "vision", errors);
  if (!isAiConfigured(textAi) && !isAiConfigured(visionAi)) {
    return { ok: false, error: "ai_settings_incomplete" };
  }
  const probe = {
      noteId: "provider-test",
      title: "AI provider test",
      author: "",
      text: "请返回一个用于连通性测试的简短 JSON。",
      comments: [],
      images: [],
      videos: []
    };
  const text = isAiConfigured(textAi) ? await testSingleAiProvider(probe, textAi, "text") : { ok: false, error: "not_configured" };
  const vision = isAiConfigured(visionAi) ? await testSingleAiProvider(probe, visionAi, "vision") : { ok: false, error: "not_configured" };
  const primary = text.ok ? text : vision;
  if (!primary.ok) return { ok: false, error: primary.error || errors.join("; ") || "ai_test_failed", text, vision };
  return {
    ok: true,
    model: primary.model,
    category: primary.category,
    summary: primary.summary,
    filename: primary.filename,
    text,
    vision
  };
}

async function testSingleAiProvider(note, ai, role) {
  try {
    const result = await callOpenAiCompatible(note, ai, null, { useImage: false, role });
    return {
      ok: true,
      model: ai.model,
      category: result.category,
      summary: result.summary,
      filename: result.filename
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function protectStoredSettings(existing = {}, incoming = {}, clearAiKey = false) {
  const oldAi = existing.ai || {};
  const incomingAi = incoming.ai || {};
  const hasLegacyIncoming = Object.prototype.hasOwnProperty.call(incomingAi, "baseUrl") ||
    Object.prototype.hasOwnProperty.call(incomingAi, "model") ||
    Object.prototype.hasOwnProperty.call(incomingAi, "apiKey");
  const legacyIncoming = hasLegacyIncoming ? protectAiSlot(oldAi, incomingAi, clearAiKey) : null;
  const nextAi = {
    ...oldAi,
    ...incomingAi,
    text: hasLegacyIncoming && !incomingAi.text ? legacyIncoming : protectAiSlot(oldAi.text || legacyAiSlot(oldAi), incomingAi.text || {}, clearAiKey),
    vision: protectAiSlot(oldAi.vision || {}, incomingAi.vision || {}, clearAiKey)
  };
  const settings = {
    ...existing,
    ...incoming,
    ai: nextAi
  };
  if (legacyIncoming) {
    settings.ai.baseUrl = legacyIncoming.baseUrl;
    settings.ai.model = legacyIncoming.model;
    if (legacyIncoming.apiKeyProtected) settings.ai.apiKeyProtected = legacyIncoming.apiKeyProtected;
    else delete settings.ai.apiKeyProtected;
  }
  delete settings.ai.apiKey;
  delete settings.ai.text.apiKey;
  delete settings.ai.vision.apiKey;
  return settings;
}

function publicSettings(settings = {}) {
  const ai = settings.ai || {};
  const text = aiSlotHasConfig(ai.text) ? ai.text : legacyAiSlot(ai);
  const vision = ai.vision || {};
  return {
    ...settings,
    ai: {
      baseUrl: ai.baseUrl || "",
      model: ai.model || "",
      apiKeyConfigured: Boolean(ai.apiKeyProtected || ai.apiKey || process.env.XHS_AI_API_KEY),
      text: publicAiSlot(text, "text"),
      vision: publicAiSlot(vision, "vision")
    }
  };
}

function protectAiSlot(oldSlot = {}, incomingSlot = {}, clearAiKey = false) {
  const slot = {
    ...oldSlot,
    ...incomingSlot
  };
  const suppliedKey = Object.prototype.hasOwnProperty.call(incomingSlot, "apiKey")
    ? String(incomingSlot.apiKey || "").trim()
    : "";
  delete slot.apiKey;
  if (clearAiKey) {
    delete slot.apiKeyProtected;
  } else if (suppliedKey) {
    slot.apiKeyProtected = protectSecret(suppliedKey);
  } else if (!slot.apiKeyProtected && oldSlot.apiKey) {
    slot.apiKeyProtected = protectSecret(String(oldSlot.apiKey));
  }
  return slot;
}

function publicAiSlot(slot = {}, role = "text") {
  const envName = role === "vision" ? "XHS_VISION_AI_API_KEY" : "XHS_TEXT_AI_API_KEY";
  return {
    baseUrl: slot.baseUrl || "",
    model: slot.model || "",
    apiKeyConfigured: Boolean(slot.apiKeyProtected || slot.apiKey || process.env[envName] || (role === "text" && process.env.XHS_AI_API_KEY))
  };
}

function legacyAiSlot(ai = {}) {
  return {
    baseUrl: ai.baseUrl || "",
    model: ai.model || "",
    apiKey: ai.apiKey || "",
    apiKeyProtected: ai.apiKeyProtected || ""
  };
}

function readRuntimeAiSettings(settings = {}, role = "text", errors = []) {
  try {
    return runtimeAiSettings(settings, role);
  } catch (error) {
    errors.push(`${role}:${error.message}`);
    return { baseUrl: "", model: "", apiKey: "" };
  }
}

function runtimeAiSettings(settings = {}, role = "text") {
  const ai = settings.ai || {};
  const slot = role === "vision" ? ai.vision || {} : aiSlotHasConfig(ai.text) ? ai.text : legacyAiSlot(ai);
  const envName = role === "vision" ? "XHS_VISION_AI_API_KEY" : "XHS_TEXT_AI_API_KEY";
  let apiKey = process.env[envName] || (role === "text" ? process.env.XHS_AI_API_KEY || "" : "");
  if (!apiKey && slot.apiKeyProtected) apiKey = unprotectSecret(slot.apiKeyProtected);
  if (!apiKey && slot.apiKey) apiKey = String(slot.apiKey);
  return {
    baseUrl: slot.baseUrl || "",
    model: slot.model || "",
    apiKey,
    role
  };
}

function isAiConfigured(ai) {
  return Boolean(ai && ai.apiKey && ai.baseUrl && ai.model);
}

function aiSlotHasConfig(slot = {}) {
  return Boolean(slot && (slot.baseUrl || slot.model || slot.apiKey || slot.apiKeyProtected));
}

function protectSecret(secret) {
  if (process.platform !== "win32") return protectPortableSecret(secret);
  const command = [
    "Add-Type -AssemblyName System.Security;",
    "$raw=[Convert]::FromBase64String($env:XHS_SECRET_INPUT);",
    "$out=[Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($out)"
  ].join(" ");
  return runSecretCommand(command, Buffer.from(secret, "utf8").toString("base64"));
}

function unprotectSecret(ciphertext) {
  if (String(ciphertext).startsWith("local-v1:")) return unprotectPortableSecret(ciphertext);
  if (process.platform !== "win32") throw new Error("secure_key_storage_requires_env_key");
  const command = [
    "Add-Type -AssemblyName System.Security;",
    "$raw=[Convert]::FromBase64String($env:XHS_SECRET_INPUT);",
    "$out=[Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($out)"
  ].join(" ");
  const plaintextBase64 = runSecretCommand(command, ciphertext);
  return Buffer.from(plaintextBase64, "base64").toString("utf8");
}

function runSecretCommand(command, input) {
  try {
    return childProcess.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, XHS_SECRET_INPUT: input },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    }).trim();
  } catch {
    throw new Error("secret_protection_failed");
  }
}

function protectPortableSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", portableSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const payload = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
  return `local-v1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;
}

function unprotectPortableSecret(ciphertext) {
  try {
    const encoded = String(ciphertext).slice("local-v1:".length);
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      portableSecretKey(),
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("secret_unprotect_failed");
  }
}

function portableSecretKey() {
  try {
    const existing = Buffer.from(fs.readFileSync(portableKeyPath, "utf8").trim(), "base64");
    if (existing.length === 32) return existing;
  } catch {
    // Generate a local secret below when no usable key exists yet.
  }
  ensureDir(archiveRoot);
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(portableKeyPath, `${key.toString("base64")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    fs.chmodSync(portableKeyPath, 0o600);
    return key;
  } catch (error) {
    if (error.code === "EEXIST") {
      const existing = Buffer.from(fs.readFileSync(portableKeyPath, "utf8").trim(), "base64");
      if (existing.length === 32) return existing;
    }
    throw new Error("secret_protection_failed");
  }
}

async function callDualAiCompatible(note, textAi, visionAi, taxonomy = null) {
  const [text, vision] = await Promise.all([
    callAiAnalyzer(note, textAi, taxonomy, { role: "text", useImage: false }).catch((error) => ({ ok: false, error: error.message })),
    callAiAnalyzer(note, visionAi, taxonomy, { role: "vision", useImage: true }).catch((error) => ({ ok: false, error: error.message }))
  ]);
  if (!text.ok && !vision.ok) throw new Error(`text:${text.error || "failed"}; vision:${vision.error || "failed"}`);
  const fusionAi = text.ok ? textAi : visionAi;
  try {
    const fused = await callAiFusion(note, fusionAi, taxonomy, { text, vision });
    return {
      ...fused,
      aiPipeline: {
        mode: "dual",
        text: summarizeAiStage(text),
        vision: summarizeAiStage(vision)
      }
    };
  } catch (error) {
    const fallback = text.ok ? text.result : vision.result;
    return {
      ...classificationFromParsed(fallback, note),
      source: "ai",
      fusionError: error.message,
      aiPipeline: {
        mode: "dual_fallback",
        text: summarizeAiStage(text),
        vision: summarizeAiStage(vision)
      }
    };
  }
}

async function callAiAnalyzer(note, ai, taxonomy = null, options = {}) {
  const prompt = buildAiPrompt(note, taxonomy, [
    options.role === "vision"
      ? "你负责封面视觉分析。重点识别封面里的场景、物品、人物风格、文字元素和视觉用途。"
      : "你负责标题文本分析。重点识别标题语义、主题、用途、地点、对象和可能分类。",
    "返回严格 JSON：categoryPath, proposedCategoryPath, tags, summary, highlights, confidence, evidence。"
  ]);
  const parsed = await fetchAiJsonWithOptionalImage(note, ai, prompt, { useImage: Boolean(options.useImage) });
  return { ok: true, result: parsed, role: options.role || ai.role || "ai" };
}

async function callAiFusion(note, ai, taxonomy = null, stages = {}) {
  const prompt = buildAiPrompt(note, taxonomy, [
    "你是最终分类裁决器。综合 text_ai_analysis 与 vision_ai_analysis 后再分类。",
    "若文字与视觉冲突，优先选择能解释标题和封面的共同主题；若只有一路可用，使用可用一路。",
    "仍然必须逐层复用受控 taxonomy 节点；新增路径放 proposedCategoryPath。",
    "返回严格 JSON：categoryPath, proposedCategoryPath, tags, summary, highlights, confidence, evidence, filename。",
    JSON.stringify({
      text_ai_analysis: stages.text && stages.text.ok ? stages.text.result : { error: stages.text && stages.text.error || "not_available" },
      vision_ai_analysis: stages.vision && stages.vision.ok ? stages.vision.result : { error: stages.vision && stages.vision.error || "not_available" }
    })
  ]);
  const parsed = await fetchAiJsonWithOptionalImage(note, ai, prompt, { useImage: false });
  return classificationFromParsed(parsed, note);
}

function summarizeAiStage(stage = {}) {
  if (!stage.ok) return { ok: false, error: stage.error || "failed" };
  const result = stage.result || {};
  return {
    ok: true,
    role: stage.role || "",
    categoryPath: normalizeCategoryPath(result.proposedCategoryPath || result.categoryPath || [result.category, result.subcategory]),
    confidence: result.confidence || ""
  };
}

async function callOpenAiCompatible(note, ai, taxonomy = null, options = {}) {
  const endpoint = `${String(ai.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const prompt = buildAiPrompt(note, taxonomy, [
    options.role === "vision"
      ? "你是小红书收藏多模态分类助手。根据标题和封面分类，不读取、不推断正文、评论或隐藏内容。"
      : "你是小红书收藏文本分类助手。根据标题、作者和封面链接文本分类，不读取、不推断正文、评论或隐藏内容。",
    "返回严格 JSON：categoryPath, proposedCategoryPath, tags, summary, highlights, filename。"
  ]);
  const parsed = await fetchAiJsonWithOptionalImage(note, ai, prompt, { useImage: options.useImage !== false });
  return classificationFromParsed(parsed, note);
}

function buildAiPrompt(note, taxonomy = null, lines = []) {
  const publicTax = taxonomy ? publicTaxonomy({ notes: {}, taxonomy }) : null;
  const controlledNodes = publicTax && Array.isArray(publicTax.nodes)
    ? publicTax.nodes
      .slice()
      .sort((a, b) => a.level - b.level || (b.locked === true) - (a.locked === true) || pathKey(a.path).localeCompare(pathKey(b.path)))
      .slice(0, 120)
      .map((node) => ({
        key: node.key,
        name: node.name,
        level: node.level,
        parentKey: node.parentKey || "",
        path: node.path,
        locked: Boolean(node.locked),
        aliases: (node.aliases || []).slice(0, 6),
        count: node.count || 0
      }))
    : [];
  const allowedChildrenByParent = {};
  for (const node of controlledNodes) {
    const parentPath = node.path.slice(0, -1).join("/") || "ROOT";
    if (!allowedChildrenByParent[parentPath]) allowedChildrenByParent[parentPath] = [];
    allowedChildrenByParent[parentPath].push({
      name: node.name,
      path: node.path,
      locked: Boolean(node.locked),
      count: node.count || 0
    });
  }
  return [
    ...lines,
    "已有分类是受控 taxonomy tree，像“界/门/纲/目/科”逐层选择。每一层必须先在当前父节点下复用已有 name，尤其 locked=true 节点。",
    "逐层选择规则：先从 ROOT 选第一层，再只允许从该父路径的 allowed_children_by_parent_path 中选下一层；不要跨父节点借用同名或近义子类。",
    "若某一层没有合适子节点，不要伪造已提交分类；返回 proposedCategoryPath 表示建议新增路径，同时 categoryPath 使用最接近的已有父路径。",
    `最多五层，层级名依次是：${TAXONOMY_LEVEL_NAMES.join(" / ")}。`,
    JSON.stringify({
      title: note.title,
      author: note.author || "",
      cover: note.cover || (note.images || [])[0] || "",
      source_url: note.url || "",
      taxonomy_level_names: TAXONOMY_LEVEL_NAMES,
      controlled_taxonomy_nodes: controlledNodes,
      allowed_children_by_parent_path: allowedChildrenByParent
    })
  ].join("\n\n");
}

async function fetchAiJsonWithOptionalImage(note, ai, prompt, options = {}) {
  const endpoint = `${String(ai.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const coverUrl = note.cover || (note.images || [])[0] || "";
  const hasImageContent = options.useImage !== false && /^https?:\/\//.test(coverUrl);
  const userContent = hasImageContent
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: coverUrl } }
      ]
    : prompt;
  let response = await fetchAiChatCompletion(endpoint, ai, userContent);
  let visionFallback = false;
  if (!response.ok && hasImageContent && [400, 404, 415, 422].includes(response.status)) {
    visionFallback = true;
    response = await fetchAiChatCompletion(endpoint, ai, `${prompt}\n\n封面链接：${coverUrl}`);
  }
  if (!response.ok) throw new Error(`ai_http_${response.status}`);
  const payload = await response.json();
  const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  if (!content) throw new Error("ai_empty_content");
  const parsed = JSON.parse(content);
  if (visionFallback) parsed.visionFallback = true;
  return parsed;
}

function classificationFromParsed(parsed, note) {
  const summary = normalizeAiText(parsed.summary);
  const highlights = normalizeAiText(parsed.highlights);
  const filename = normalizeAiText(parsed.filename);
  return {
    ...normalizeClassification(parsed.proposedCategoryPath && normalizeCategoryPath(parsed.proposedCategoryPath).length ? {
      ...parsed,
      categoryPath: parsed.proposedCategoryPath
    } : parsed, inferTaxonomy(note)),
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 12) : [],
    summary,
    highlights,
    filename: sanitizeFilename(filename || summarizeForFilename(note), "xhs-note"),
    source: "ai",
    visionFallback: Boolean(parsed.visionFallback)
  };
}

async function fetchAiChatCompletion(endpoint, ai, userContent) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ai.apiKey}`
    },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You produce concise JSON for Markdown archiving." },
        { role: "user", content: userContent }
      ]
    })
  });
}

async function archiveMedia(note) {
  const mediaDir = path.join(archiveRoot, "media", sanitizeFilename(note.noteId || "unknown"));
  ensureDir(mediaDir);
  const localImages = [];
  const localVideos = [];
  const errors = [];
  const imageUrls = Array.from(new Set([note.cover, ...(note.images || [])].filter(Boolean))).slice(0, 30);
  const videoUrls = Array.from(new Set(note.videos || [])).slice(0, 5);

  for (let index = 0; index < imageUrls.length; index += 1) {
    if (index > 0 && MEDIA_DOWNLOAD_DELAY_MS > 0) await sleep(MEDIA_DOWNLOAD_DELAY_MS);
    const result = await downloadUrlToFile(imageUrls[index], mediaDir, `image-${String(index + 1).padStart(2, "0")}`, MEDIA_MAX_IMAGE_BYTES);
    if (result.ok) localImages.push(result.file);
    else errors.push({ url: imageUrls[index], error: result.error });
  }

  for (let index = 0; index < videoUrls.length; index += 1) {
    if ((imageUrls.length || index > 0) && MEDIA_DOWNLOAD_DELAY_MS > 0) await sleep(MEDIA_DOWNLOAD_DELAY_MS);
    const result = await downloadUrlToFile(videoUrls[index], mediaDir, `video-${String(index + 1).padStart(2, "0")}`, MEDIA_MAX_VIDEO_BYTES);
    if (result.ok) localVideos.push(result.file);
    else errors.push({ url: videoUrls[index], error: result.error });
  }

  return {
    notePatch: {
      localImages,
      localVideos,
      mediaErrors: errors,
      statuses: {
        ...(note.statuses || {}),
        mediaArchived: localImages.length > 0 || localVideos.length > 0,
        mediaErrors: errors.length
      }
    }
  };
}

async function downloadUrlToFile(url, dir, basename, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: "unsupported_protocol" };
    if (isLocalOrPrivateHost(parsed.hostname)) return { ok: false, error: "blocked_private_host" };
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        "user-agent": "Mozilla/5.0",
        "accept": "*/*"
      }
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength && declaredLength > maxBytes) return { ok: false, error: "media_too_large" };
    const contentType = response.headers.get("content-type") || "";
    const extension = extensionFromContentType(contentType) || path.extname(parsed.pathname).slice(0, 8) || ".bin";
    const file = path.join(dir, `${basename}${extension.startsWith(".") ? extension : `.${extension}`}`);
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) return { ok: false, error: "media_too_large" };
    fs.writeFileSync(file, Buffer.from(arrayBuffer));
    return { ok: true, file };
  } catch (error) {
    if (error.name === "AbortError") return { ok: false, error: "media_download_timeout" };
    if (/redirect/i.test(error.message)) return { ok: false, error: "redirect_blocked" };
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipVersion = net.isIP(host);
  if (!ipVersion) return false;
  if (ipVersion === 6) {
    return host === "::1" || host.startsWith("::ffff:") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  }
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168
  );
}

function extensionFromContentType(contentType) {
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("mpegurl")) return ".m3u8";
  return "";
}

function readLocalMedia(file) {
  if (!file || !isInsideArchiveRoot(file)) return { ok: false, error: "media_path_denied" };
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return { ok: false, error: "media_not_file" };
  if (stat.size > MEDIA_READ_MAX_BYTES) return { ok: false, error: "media_read_too_large" };
  const buffer = fs.readFileSync(resolved);
  const contentType = contentTypeFromFile(resolved);
  return {
    ok: true,
    file: resolved,
    contentType,
    dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`
  };
}

function contentTypeFromFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".m3u8") return "application/vnd.apple.mpegurl";
  return "application/octet-stream";
}

function deleteNoteFiles(note) {
  if (!note) return;
  for (const file of [note.markdownPath, ...(note.localImages || []), ...(note.localVideos || [])]) {
    if (!file) continue;
    try {
      if (isInsideArchiveRoot(file)) fs.rmSync(path.resolve(file), { force: true });
    } catch {
      // Best effort local cleanup. Database deletion should still proceed.
    }
  }
}

function isInsideArchiveRoot(file) {
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sendNativeMessage(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

if (require.main === module) {
  let pending = Buffer.alloc(0);
  process.stdin.on("data", async (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (pending.length < length + 4) return;
      const body = pending.slice(4, length + 4);
      pending = pending.slice(length + 4);
      try {
        const message = JSON.parse(body.toString("utf8"));
        const result = await handleMessage(message);
        sendNativeMessage(result);
      } catch (error) {
        sendNativeMessage({ ok: false, error: error.message });
      }
    }
  });

  process.stdin.resume();
}

module.exports = { handleMessage, buildLocalAiFallback };
