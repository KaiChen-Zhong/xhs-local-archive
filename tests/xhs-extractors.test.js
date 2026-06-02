"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractCollectionPageNotes,
  extractNotesFromJsonPayload,
  extractNoteId
} = require("../extension/xhs-extractors");

test("extractNoteId handles xhs explore URLs", () => {
  assert.equal(extractNoteId("https://www.xiaohongshu.com/explore/64abc123?xsec_token=t"), "64abc123");
  assert.equal(extractNoteId("https://www.xiaohongshu.com/user/profile/user123/64abc123?xsec_token=t"), "64abc123");
});

test("extracts feed note cards as title-cover records", () => {
  const payload = {
    data: {
      items: [
        {
          note_card: {
            note_id: "note1",
            display_title: "上海咖啡店",
            desc: "适合周末去",
            user: { nickname: "作者A" },
            cover: { url_default: "https://img.example/cover.jpg" },
            image_list: [{ url_default: "https://img.example/1.jpg" }],
            video_info: { master_url: "https://video.example/v.mp4" },
            xsec_token: "token1"
          }
        }
      ]
    }
  };
  const notes = extractNotesFromJsonPayload(payload, "https://edith.xiaohongshu.com/api/sns/web/v1/homefeed");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].noteId, "note1");
  assert.equal(notes[0].url, "https://www.xiaohongshu.com/explore/note1?xsec_token=token1");
  assert.equal(notes[0].xsecToken, "token1");
  assert.equal(notes[0].author, "作者A");
  assert.equal(notes[0].cover, "https://img.example/cover.jpg");
  assert.equal(notes[0].text, undefined);
  assert.equal(notes[0].comments, undefined);
  assert.equal(notes[0].statuses.cardOnly, true);
});

test("extracts collect page notes in exact array order", () => {
  const payload = {
    data: {
      notes: [
        { note_id: "collect1", display_title: "收藏一", cover: { url_default: "https://img.example/1.jpg" }, xsec_token: "token1" },
        { note_id: "collect2", display_title: "收藏二", cover: { url_default: "https://img.example/2.jpg" }, xsec_token: "token2" }
      ],
      cursor: "collect2"
    }
  };
  const result = extractCollectionPageNotes(payload, "https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page");
  assert.equal(result.responseCursor, "collect2");
  assert.deepEqual(result.notes.map((note) => note.noteId), ["collect1", "collect2"]);
  assert.equal(result.notes[0].title, "收藏一");
  assert.equal(result.notes[0].cover, "https://img.example/1.jpg");
});

test("ignores detail text and comments from note-like payload", () => {
  const payload = {
    data: {
      note: {
        id: "note2",
        title: "教程",
        content: "步骤一二三",
        comments: [
          {
            user: { nickname: "用户A" },
            content: "有用",
            like_count: 10,
            sub_comments: [{ user: { nickname: "用户B" }, content: "同意" }]
          }
        ]
      }
    }
  };
  const notes = extractNotesFromJsonPayload(payload, "detail");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, undefined);
  assert.equal(notes[0].comments, undefined);
});

test("does not treat comment-only rows as notes", () => {
  const payload = {
    data: {
      comments: [
        {
          id: "comment1",
          user: { nickname: "用户A" },
          content: "很实用",
          like_count: 8,
          sub_comments: [{ id: "comment2", content: "已收藏" }]
        }
      ]
    }
  };
  const notes = extractNotesFromJsonPayload(payload, "comment/page");
  assert.equal(notes.length, 0);
});
