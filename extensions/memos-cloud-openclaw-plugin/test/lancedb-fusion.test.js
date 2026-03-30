import test from "node:test";
import assert from "node:assert/strict";
import { mergeAndFormat, formatLanceDBOnly } from "../lib/lancedb-fusion.js";

test("mergeAndFormat limits unified recall by topK while retaining lancedb precision block", () => {
  const block = mergeAndFormat(
    [
      { text: "本地高优先", category: "fact", timestamp: 1710000000000 },
      { text: "本地第二条", category: "fact", timestamp: 1710000001000 },
    ],
    null,
    {
      topK: 2,
      lancedbPriority: 1,
      unifiedResults: [
        { source: "lancedb", type: "fact", text: "本地高优先" },
        { source: "memos", type: "text_mem", text: "远端补位一" },
        { source: "memos", type: "pref_mem", text: "远端补位二" },
      ],
    },
  );

  assert.ok(block.includes("<lancedb-precision>"));
  assert.ok(block.includes("本地高优先"));
  assert.ok(!block.includes("本地第二条"));
  assert.ok(block.includes("<unified-recall>"));
  assert.ok(block.includes("[lancedb/fact] 本地高优先"));
  assert.ok(block.includes("[memos/text_mem] 远端补位一"));
  assert.ok(!block.includes("远端补位二"));
});

test("mergeAndFormat backfills memories from multiple normalized sources", () => {
  const block = mergeAndFormat([], null, {
    topK: 2,
    normalizedMemos: {
      textMem: [{ text: "文本事实一" }, { text: "文本事实二" }, { text: "文本事实三" }],
      prefMem: [{ text: "偏好一" }, { text: "偏好二" }, { text: "偏好三" }, { text: "偏好四" }],
      toolMem: [{ text: "工具一" }, { text: "工具二" }],
      skillMem: [{ text: "技能一" }],
    },
  });

  assert.ok(block.includes("<memories>"));
  assert.ok(block.includes("文本事实一"));
  assert.ok(block.includes("文本事实二"));
  assert.ok(!block.includes("文本事实三"));
  assert.ok(block.includes("偏好一"));
  assert.ok(block.includes("偏好二"));
  assert.ok(block.includes("偏好三"));
  assert.ok(!block.includes("偏好四"));
  assert.ok(block.includes("<tool-memories>"));
  assert.ok(block.includes("工具一"));
  assert.ok(block.includes("工具二"));
  assert.ok(block.includes("<skill-memories>"));
  assert.ok(block.includes("技能一"));
});

test("mergeAndFormat keeps legacy sections but dedupes duplicate text inside compact recall", () => {
  const block = mergeAndFormat(
    [
      { text: "重复记忆", category: "fact", timestamp: 1710000000000 },
    ],
    null,
    {
      unifiedResults: [
        { source: "lancedb", type: "fact", text: "重复记忆" },
        { source: "memos", type: "text_mem", text: "重复记忆" },
      ],
      normalizedMemos: {
        textMem: [{ text: "重复记忆" }],
        prefMem: [],
        toolMem: [],
        skillMem: [],
      },
    },
  );

  assert.ok(block.includes("<lancedb-precision>"));
  assert.ok(block.includes("<unified-recall>"));
  assert.ok(block.includes("<memories>"));
  const recallSection = block.match(/<recall>[\s\S]*?<\/recall>/)?.[0] || "";
  assert.equal((recallSection.match(/重复记忆/g) || []).length, 1);
});

test("mergeAndFormat falls back to raw memosData compatibility shape", () => {
  const block = mergeAndFormat([], {
    memory_detail_list: [
      { memory_value: "原始事实", create_time: 1710000000000 },
      { memory_key: "备用事实", create_time: 1710000001000 },
    ],
    preference_detail_list: [
      { preference: "偏好浅色背景", preference_type: "explicit_preference" },
    ],
    tool_memory_detail_list: [
      { tool_value: "使用 ffmpeg" },
    ],
  });

  assert.ok(block.includes("<memories>"));
  assert.ok(block.includes("原始事实"));
  assert.ok(block.includes("备用事实"));
  assert.ok(block.includes("[Explicit Preference] 偏好浅色背景"));
  assert.ok(block.includes("<tool-memories>"));
  assert.ok(block.includes("使用 ffmpeg"));
});

test("mergeAndFormat also emits compact recall block and dedupes cross-source exact text", () => {
  const block = mergeAndFormat(
    [
      { text: "用户喜欢吃辣", score: 0.95, category: "fact", timestamp: 200 },
    ],
    null,
    {
      topK: 6,
      normalizedMemos: {
        textMem: [{ text: "  用户喜欢吃辣\n", score: 0.8, raw: { create_time: 150 } }],
        prefMem: [],
        toolMem: [],
        skillMem: [],
      },
      unifiedResults: [
        { source: "lancedb", type: "fact", text: "用户喜欢吃辣", score: 0.95, timestamp: 200 },
        { source: "memos", type: "text_mem", text: "用户喜欢吃辣", score: 0.8, timestamp: 150 },
      ],
    },
  );

  assert.ok(block.includes("<recall>"));
  const recallSection = block.match(/<recall>[\s\S]*?<\/recall>/)?.[0] || "";
  assert.equal((recallSection.match(/用户喜欢吃辣/g) || []).length, 1);
  assert.ok(recallSection.includes("[lancedb/fact] 用户喜欢吃辣"));
});

test("formatLanceDBOnly dedupes normalized duplicate texts", () => {
  const output = formatLanceDBOnly([
    { text: "重复记忆", category: "fact", timestamp: 100 },
    { text: "  重复记忆\n", category: "fact", timestamp: 90 },
  ], { topK: 4 });

  assert.equal((output.match(/重复记忆/g) || []).length, 1);
});
