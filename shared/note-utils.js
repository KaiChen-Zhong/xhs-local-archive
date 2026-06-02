"use strict";

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WHITESPACE = /\s+/g;

function normalizeSpace(value) {
  return String(value || "").replace(WHITESPACE, " ").trim();
}

function stableNoteId(input) {
  const raw = String(input || "");
  const urlMatch = raw.match(/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  const profileNoteMatch = raw.match(/user\/profile\/[A-Za-z0-9_-]+\/([A-Za-z0-9]+)/);
  if (profileNoteMatch) return profileNoteMatch[1];
  const queryMatch = raw.match(/[?&](?:noteId|note_id)=([A-Za-z0-9]+)/);
  if (queryMatch) return queryMatch[1];
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
}

function sourceUrlWithToken(url, xsecToken) {
  const rawUrl = String(url || "");
  const token = String(xsecToken || "").trim();
  if (!rawUrl || !token) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if ((parsed.hostname === "xiaohongshu.com" || parsed.hostname.endsWith(".xiaohongshu.com")) && !parsed.searchParams.get("xsec_token")) {
      parsed.searchParams.set("xsec_token", token);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeFilename(value, fallback = "xhs-note") {
  const cleaned = normalizeSpace(value)
    .replace(INVALID_FILENAME_CHARS, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 96)
    .trim();
  return cleaned || fallback;
}

function summarizeForFilename(note) {
  const title = normalizeSpace(note.title);
  const text = normalizeSpace(note.text || note.desc || note.summary);
  const seed = title || text.slice(0, 40) || note.noteId || "xhs-note";
  return sanitizeFilename(seed, "xhs-note");
}

function dedupeArray(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function mergeNote(existing = {}, incoming = {}) {
  const noteId = incoming.noteId || existing.noteId || stableNoteId(incoming.url || existing.url || "");
  const xsecToken = incoming.xsecToken || existing.xsecToken || "";
  const discoveryIndex = mergeDiscoveryIndex(existing, incoming);
  const merged = {
    ...existing,
    ...incoming,
    noteId,
    title: normalizeSpace(incoming.title || existing.title),
    author: normalizeSpace(incoming.author || existing.author),
    text: normalizeSpace(incoming.text || existing.text),
    url: sourceUrlWithToken(incoming.url || existing.url || "", xsecToken),
    cover: incoming.cover || existing.cover || "",
    xsecToken,
    discoveryIndex,
    source: incoming.source || existing.source || "unknown",
    images: dedupeArray([...(existing.images || []), ...(incoming.images || [])]),
    videos: dedupeArray([...(existing.videos || []), ...(incoming.videos || [])]),
    comments: mergeComments(existing.comments || [], incoming.comments || []),
    statuses: {
      ...(existing.statuses || {}),
      ...(incoming.statuses || {})
    },
    updatedAt: new Date().toISOString()
  };
  if (!merged.createdAt) merged.createdAt = incoming.createdAt || existing.createdAt || merged.updatedAt;
  return merged;
}

function mergeDiscoveryIndex(existing = {}, incoming = {}) {
  const existingIndex = Number(existing.discoveryIndex);
  const incomingIndex = Number(incoming.discoveryIndex);
  const hasExistingIndex = Number.isFinite(existingIndex);
  const hasIncomingIndex = Number.isFinite(incomingIndex);
  const incomingIsApi = isApiOrdered(incoming);
  const existingIsApi = isApiOrdered(existing);
  const incomingIsVisual = isVisualOrdered(incoming);
  const existingIsVisual = isVisualOrdered(existing);
  if (hasIncomingIndex && (
    !hasExistingIndex ||
    (incomingIsApi && !existingIsApi) ||
    (incomingIsApi && existingIsApi && incomingIndex < existingIndex) ||
    (incomingIsVisual && !existingIsApi && !existingIsVisual)
  )) return incomingIndex;
  if (hasExistingIndex) return existingIndex;
  return hasIncomingIndex ? incomingIndex : undefined;
}

function isApiOrdered(note = {}) {
  return Boolean(note.statuses && note.statuses.apiOrdered);
}

function isVisualOrdered(note = {}) {
  if (note.statuses && note.statuses.visualOrdered) return true;
  return /^(manual|start-scan|controlled-scan|mutation|scan-stop)$/.test(String(note.source || ""));
}

function mergeComments(existing, incoming) {
  const seen = new Set();
  const result = [];
  for (const item of [...existing, ...incoming]) {
    const text = normalizeSpace(item && item.text);
    if (!text) continue;
    const key = `${normalizeSpace(item.user)}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      user: normalizeSpace(item.user),
      text,
      likes: Number.isFinite(Number(item.likes)) ? Number(item.likes) : 0
    });
  }
  return result;
}

function captureCoverage(note) {
  return {
    hasCard: Boolean(normalizeSpace(note.title || note.cover || note.url)),
    hasText: Boolean(normalizeSpace(note.text)),
    imageCount: dedupeArray([...(note.images || []), ...(note.localImages || [])]).length,
    videoCount: dedupeArray([...(note.videos || []), ...(note.localVideos || [])]).length,
    commentCount: (note.comments || []).length
  };
}

function canArchiveNote(note) {
  const coverage = captureCoverage(note);
  return coverage.hasCard || coverage.hasText || coverage.imageCount > 0 || coverage.videoCount > 0;
}

function noteCompleteness(note) {
  const coverage = captureCoverage(note);
  if (note.unavailableReason) return "unavailable";
  if (note.markdownPath) return canArchiveNote(note) ? "archived" : "partial-archived";
  return "discovered";
}

function markdownEscape(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function renderMarkdown(note, ai = {}) {
  const tags = dedupeArray([...(ai.tags || []), ...(note.tags || [])]);
  const categoryPath = normalizeCategoryPath(ai.categoryPath || [ai.category, ai.subcategory]);
  const category = categoryPath[0] || "未分类";
  const subcategory = categoryPath[1] || "待细分";
  const status = noteCompleteness(note);
  const frontmatter = [
    "---",
    `note_id: ${note.noteId || ""}`,
    `source_url: ${note.url || ""}`,
    `author: ${JSON.stringify(note.author || "")}`,
    `status: ${status}`,
    `created_at: ${note.createdAt || ""}`,
    `archived_at: ${new Date().toISOString()}`,
    `category: ${JSON.stringify(category)}`,
    `subcategory: ${JSON.stringify(subcategory)}`,
    `category_path: [${categoryPath.map((item) => JSON.stringify(item)).join(", ")}]`,
    `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    "---"
  ].join("\n");

  const comments = (note.comments || [])
    .slice(0, 20)
    .map((comment) => `- ${comment.user ? `**${comment.user}**: ` : ""}${markdownEscape(comment.text)}${comment.likes ? ` (${comment.likes})` : ""}`)
    .join("\n");

  const images = dedupeArray([...(note.localImages || []), note.cover, ...(note.images || [])])
    .map((image) => `![](${image})`)
    .join("\n\n");

  const videos = dedupeArray([...(note.localVideos || []), ...(note.videos || [])])
    .map((video) => `- ${video}`)
    .join("\n");

  return `${frontmatter}

# ${markdownEscape(note.title || ai.filename || note.noteId || "XHS Note")}

来源：${note.url || "unknown"}

作者：${markdownEscape(note.author || "unknown")}

## AI 分类

- 分类：${markdownEscape(ai.category || "未分类")}
- 小分类：${markdownEscape(ai.subcategory || "待细分")}
- 分类路径：${categoryPath.join(" / ")}
- 标签：${tags.length ? tags.join(", ") : "无"}

## 摘要

${markdownEscape(ai.summary || note.summary || "未生成摘要")}

## 精华内容

${markdownEscape(ai.highlights || note.highlights || "未提取精华内容。")}

## 正文

${markdownEscape(note.text || "未读取帖子正文。")}

## 精华评论

${comments || "未读取帖子评论。"}

## 媒体

${images || "媒体未保存。"}

## 视频

${videos || "视频未保存。"}
`;
}

function normalizeCategoryPath(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeSpace(item)).filter(Boolean).slice(0, 5);
  return String(value || "").split(/[/>｜|,，]/).map((item) => normalizeSpace(item)).filter(Boolean).slice(0, 5);
}

module.exports = {
  normalizeSpace,
  stableNoteId,
  sourceUrlWithToken,
  sanitizeFilename,
  summarizeForFilename,
  mergeNote,
  mergeComments,
  captureCoverage,
  canArchiveNote,
  noteCompleteness,
  renderMarkdown
};
