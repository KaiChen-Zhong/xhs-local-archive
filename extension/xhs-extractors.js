(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.XhsExtractors = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function extractNotesFromJsonPayload(payload, sourceUrl) {
    const notes = [];
    walkJson(payload, (node) => {
      const note = normalizeJsonNote(node, sourceUrl);
      if (note && note.noteId) notes.push(note);
    });
    return dedupeNotes(notes);
  }

  function normalizeJsonNote(node, sourceUrl) {
    if (!node || typeof node !== "object") return null;
    if (isCommentOnlyContainer(node)) return null;

    const card = firstObject(
      node.note_card,
      node.noteCard,
      node.note,
      node.noteInfo,
      node.note_info,
      node
    );

    const noteId = pickString(
      node.note_id,
      node.noteId,
      node.id,
      card.note_id,
      card.noteId,
      card.id
    );
    const rawUrl = pickString(card.url, card.share_url, card.shareUrl, node.url, node.share_url);
    const rawToken = pickString(card.xsec_token, card.xsecToken, node.xsec_token, node.xsecToken, tokenFromUrl(rawUrl));
    const url = sourceUrlWithToken(rawUrl || (noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : ""), rawToken);
    const normalizedId = noteId || extractNoteId(url);
    if (!normalizedId || !looksLikeNote(card, node)) return null;

    const user = firstObject(card.user, card.user_info, card.userInfo, node.user, node.user_info);
    const cover = pickMediaUrl(card.cover, card.cover_info, card.image, card.image_info);
    return {
      noteId: String(normalizedId),
      url,
      title: pickString(card.title, card.display_title, card.displayTitle, node.title, node.display_title, card.desc).slice(0, 200),
      author: pickString(user.nickname, user.name, user.nick_name, card.nickname, node.nickname).slice(0, 120),
      cover,
      xsecToken: rawToken,
      source: `network:${sourceUrl || "unknown"}`,
      statuses: {
        networkCaptured: true,
        cardOnly: true
      },
      createdAt: new Date().toISOString()
    };
  }

  function looksLikeNote(card, node) {
    const type = pickString(card.type, node.type, card.model_type, node.model_type).toLowerCase();
    if (type && /user|topic|ad|comment/.test(type) && !/note|feed/.test(type)) return false;
    const wrappedNote = Boolean(node.note_card || node.noteCard || node.note || node.noteInfo || node.note_info);
    const hasTitle = Boolean(card.title || card.display_title || card.displayTitle);
    const hasMedia = Boolean(card.image_list || card.images || card.video || card.cover);
    const hasNoteSpecificId = Boolean(card.note_id || card.noteId || node.note_id || node.noteId);
    const hasNoteSpecificLink = Boolean(card.url || card.share_url || card.shareUrl || node.url || node.share_url || card.xsec_token || node.xsec_token);
    const commentShape = Boolean(
      !wrappedNote &&
      !hasTitle &&
      !hasMedia &&
      (node.like_count !== undefined || node.likeCount !== undefined || node.sub_comments || node.subComments || node.replies) &&
      (node.content || node.text || node.desc)
    );
    if (commentShape) return false;
    const genericTextRow = Boolean(
      !wrappedNote &&
      !hasTitle &&
      !hasMedia &&
      !hasNoteSpecificId &&
      !hasNoteSpecificLink &&
      node.id &&
      (node.content || node.text || node.desc)
    );
    if (genericTextRow) return false;
    return Boolean(
      wrappedNote ||
      card.title ||
      card.display_title ||
      card.desc ||
      card.content ||
      card.image_list ||
      card.images ||
      card.video ||
      card.cover ||
      node.note_card ||
      node.noteCard
    );
  }

  function isCommentOnlyContainer(node) {
    const hasCommentList = Boolean(node.comments || node.comment_list || node.commentList);
    if (!hasCommentList) return false;
    const hasNoteWrapper = Boolean(node.note_card || node.noteCard || node.note || node.noteInfo || node.note_info);
    const hasNoteFields = Boolean(
      node.note_id ||
      node.noteId ||
      node.title ||
      node.display_title ||
      node.displayTitle ||
      node.desc ||
      node.image_list ||
      node.images ||
      node.video ||
      node.cover
    );
    return !hasNoteWrapper && !hasNoteFields;
  }

  function walkJson(value, visitor, depth = 0, seen = new Set()) {
    if (depth > 10 || value == null) return;
    if (typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) walkJson(item, visitor, depth + 1, seen);
      return;
    }
    if (typeof value === "object") {
      visitor(value);
      for (const item of Object.values(value)) walkJson(item, visitor, depth + 1, seen);
    }
  }

  function collectUrls(value, out) {
    if (!value) return;
    if (typeof value === "string") {
      if (/^https?:\/\//.test(value)) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectUrls(item, out));
      return;
    }
    if (typeof value === "object") {
      for (const key of ["url", "url_default", "urlDefault", "url_pre", "urlPre", "master_url", "masterUrl", "backup_urls", "backupUrls", "origin_url", "originUrl"]) {
        collectUrls(value[key], out);
      }
    }
  }

  function pickMediaUrl(...values) {
    const urls = [];
    for (const value of values) collectUrls(value, urls);
    return urls[0] || "";
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
  }

  function firstObject(...values) {
    return values.find((value) => value && typeof value === "object") || {};
  }

  function pickString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  }

  function extractNoteId(url) {
    const match = String(url || "").match(/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/) ||
      String(url || "").match(/user\/profile\/[A-Za-z0-9_-]+\/([A-Za-z0-9]+)/);
    return match ? match[1] : "";
  }

  function tokenFromUrl(url) {
    try {
      return new URL(url).searchParams.get("xsec_token") || "";
    } catch {
      return "";
    }
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

  function dedupe(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function dedupeNotes(notes) {
    const byId = new Map();
    for (const note of notes) {
      if (!byId.has(note.noteId)) {
        byId.set(note.noteId, note);
        continue;
      }
      const existing = byId.get(note.noteId);
      const images = dedupe([...(existing.images || []), ...(note.images || [])]);
      const videos = dedupe([...(existing.videos || []), ...(note.videos || [])]);
      const merged = {
        ...existing,
        ...note,
        title: note.title || existing.title,
        author: note.author || existing.author,
        text: note.text || existing.text,
        cover: note.cover || existing.cover,
        statuses: { ...(existing.statuses || {}), ...(note.statuses || {}) }
      };
      if (images.length) merged.images = images;
      else delete merged.images;
      if (videos.length) merged.videos = videos;
      else delete merged.videos;
      byId.set(note.noteId, merged);
    }
    return Array.from(byId.values());
  }

  return {
    extractNotesFromJsonPayload,
    normalizeJsonNote,
    collectUrls,
    extractNoteId
  };
});
