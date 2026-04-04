import test from "node:test";
import assert from "node:assert/strict";
import { mergeAndFormat, formatLanceDBOnly } from "../lib/lancedb-fusion.js";

test("mergeAndFormat limits unified recall by topK under single recall block", () => {
  const block = mergeAndFormat(
    [
      { text: "local primary fact", category: "fact", timestamp: 1710000000000 },
      { text: "local second fact", category: "fact", timestamp: 1710000001000 },
    ],
    null,
    {
      topK: 2,
      unifiedResults: [
        { source: "lancedb", type: "fact", text: "local primary fact" },
        { source: "memos", type: "text_mem", text: "remote text one" },
        { source: "memos", type: "pref_mem", text: "remote pref two" },
      ],
    },
  );

  assert.ok(block.includes("<recall>"));
  assert.ok(block.includes("[lancedb/fact] local primary fact"));
  assert.ok(block.includes("[memos/text_mem] remote text one"));
  assert.ok(!block.includes("local second fact"));
  assert.ok(!block.includes("remote pref two"));
});

test("mergeAndFormat backfills from normalized sources and keeps tool or skill entries inside recall", () => {
  const block = mergeAndFormat([], null, {
    topK: 5,
    normalizedMemos: {
      textMem: [{ text: "text fact one" }, { text: "text fact two" }, { text: "text fact three" }],
      prefMem: [{ text: "pref one" }, { text: "pref two" }, { text: "pref three" }, { text: "pref four" }],
      toolMem: [{ text: "tool one" }, { text: "tool two" }],
      skillMem: [{ text: "skill one" }],
    },
  });

  assert.ok(block.includes("<recall>"));
  assert.ok(block.includes("text fact one"));
  assert.ok(block.includes("text fact two"));
  assert.ok(block.includes("pref one"));
  assert.ok(block.includes("pref two"));
  assert.ok(block.includes("[memos/tool_mem] tool one"));
  assert.ok(block.includes("[memos/tool_mem] tool two"));
  assert.ok(block.includes("[memos/skill_mem] skill one"));
});

test("mergeAndFormat dedupes duplicate text inside compact recall", () => {
  const block = mergeAndFormat(
    [{ text: "duplicate memory", category: "fact", timestamp: 1710000000000 }],
    null,
    {
      unifiedResults: [
        { source: "lancedb", type: "fact", text: "duplicate memory" },
        { source: "memos", type: "text_mem", text: "duplicate memory" },
      ],
      normalizedMemos: {
        textMem: [{ text: "duplicate memory" }],
        prefMem: [],
        toolMem: [],
        skillMem: [],
      },
    },
  );

  const recallSection = block.match(/<recall>[\s\S]*?<\/recall>/)?.[0] || "";
  assert.ok(recallSection.includes("duplicate memory"));
  assert.equal((recallSection.match(/duplicate memory/g) || []).length, 1);
});

test("mergeAndFormat falls back to raw memosData compatibility shape", () => {
  const block = mergeAndFormat([], {
    memory_detail_list: [
      { memory_value: "raw fact", create_time: 1710000000000 },
      { memory_key: "backup fact", create_time: 1710000001000 },
    ],
    preference_detail_list: [
      { preference: "prefer light background", preference_type: "explicit_preference" },
    ],
    tool_memory_detail_list: [
      { tool_value: "use ffmpeg" },
    ],
  });

  assert.ok(block.includes("<recall>"));
  assert.ok(block.includes("raw fact"));
  assert.ok(block.includes("backup fact"));
  assert.ok(block.includes("[memos/Explicit Preference] prefer light background"));
  assert.ok(block.includes("[memos/tool_mem] use ffmpeg"));
});

test("mergeAndFormat dedupes cross-source exact text under single recall block", () => {
  const block = mergeAndFormat(
    [{ text: "user likes spicy food", score: 0.95, category: "fact", timestamp: 200 }],
    null,
    {
      topK: 6,
      normalizedMemos: {
        textMem: [{ text: "user likes spicy food", score: 0.8, raw: { create_time: 150 } }],
        prefMem: [],
        toolMem: [],
        skillMem: [],
      },
      unifiedResults: [
        { source: "lancedb", type: "fact", text: "user likes spicy food", score: 0.95, timestamp: 200 },
        { source: "memos", type: "text_mem", text: "user likes spicy food", score: 0.8, timestamp: 150 },
      ],
    },
  );

  const recallSection = block.match(/<recall>[\s\S]*?<\/recall>/)?.[0] || "";
  assert.equal((recallSection.match(/user likes spicy food/g) || []).length, 1);
  assert.ok(recallSection.includes("[lancedb/fact] user likes spicy food"));
});

test("formatLanceDBOnly dedupes normalized duplicate texts", () => {
  const output = formatLanceDBOnly([
    { text: "duplicate memory", category: "fact", timestamp: 100 },
    { text: "duplicate memory", category: "fact", timestamp: 90 },
  ], { topK: 4 });

  assert.equal((output.match(/duplicate memory/g) || []).length, 1);
});
