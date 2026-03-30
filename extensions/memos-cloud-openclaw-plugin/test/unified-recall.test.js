import test from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedRecallResults, summarizeUnifiedRecall } from "../lib/unified-recall.js";

test("buildUnifiedRecallResults merges and sorts lancedb + memos results", () => {
  const lancedbResults = [
    { text: "本地高精度记忆", score: 0.9, category: "fact", timestamp: 100 },
  ];
  const normalizedMemos = {
    textMem: [{ text: "远端文本记忆", score: 0.7, raw: { create_time: 90 } }],
    prefMem: [{ text: "远端偏好记忆", score: 0.8, raw: { create_time: 95 } }],
    toolMem: [],
    skillMem: [],
    actMem: [],
    paraMem: [],
  };

  const unified = buildUnifiedRecallResults(lancedbResults, normalizedMemos);
  assert.equal(unified.length, 3);
  assert.equal(unified[0].source, "lancedb");
  assert.equal(unified[1].type, "pref_mem");
  assert.equal(unified[2].type, "text_mem");
});

test("summarizeUnifiedRecall produces compact preview", () => {
  const preview = summarizeUnifiedRecall([
    { source: "lancedb", type: "fact", score: 0.9, text: "hello world" },
  ]);
  assert.deepEqual(preview, [
    { source: "lancedb", type: "fact", score: 0.9, text: "hello world" },
  ]);
});

test("buildUnifiedRecallResults keeps lancedb preview for LanceDB-only recalls", () => {
  const unified = buildUnifiedRecallResults([
    { text: "仅本地记忆", score: 0.88, category: "fact", timestamp: 101 },
  ], null);

  assert.equal(unified.length, 1);
  assert.deepEqual(summarizeUnifiedRecall(unified), [
    { source: "lancedb", type: "fact", score: 0.88, text: "仅本地记忆" },
  ]);
});

test("buildUnifiedRecallResults uses per-source quotas for mixed topK", () => {
  const lancedbResults = [
    { text: "L1", score: 0.99, category: "fact", timestamp: 300 },
    { text: "L2", score: 0.97, category: "fact", timestamp: 290 },
    { text: "L3", score: 0.95, category: "fact", timestamp: 280 },
  ];
  const normalizedMemos = {
    textMem: [
      { text: "M1", score: 0.94, raw: { create_time: 270 } },
      { text: "M2", score: 0.93, raw: { create_time: 260 } },
      { text: "M3", score: 0.92, raw: { create_time: 250 } },
    ],
    prefMem: [],
    toolMem: [],
    skillMem: [],
    actMem: [],
    paraMem: [],
  };

  const unified = buildUnifiedRecallResults(lancedbResults, normalizedMemos, { topK: 4 });

  assert.equal(unified.length, 4);
  assert.deepEqual(unified.map((item) => item.text), ["L1", "M1", "L2", "M2"]);
  assert.equal(unified.filter((item) => item.source === "lancedb").length, 2);
  assert.equal(unified.filter((item) => item.source === "memos").length, 2);
});

test("buildUnifiedRecallResults backfills remaining slots when one source lacks enough hits", () => {
  const lancedbResults = [
    { text: "L1", score: 0.99, category: "fact", timestamp: 300 },
  ];
  const normalizedMemos = {
    textMem: [
      { text: "M1", score: 0.96, raw: { create_time: 295 } },
      { text: "M2", score: 0.95, raw: { create_time: 285 } },
      { text: "M3", score: 0.94, raw: { create_time: 275 } },
      { text: "M4", score: 0.93, raw: { create_time: 265 } },
    ],
    prefMem: [],
    toolMem: [],
    skillMem: [],
    actMem: [],
    paraMem: [],
  };

  const unified = buildUnifiedRecallResults(lancedbResults, normalizedMemos, { topK: 4 });

  assert.equal(unified.length, 4);
  assert.deepEqual(unified.map((item) => item.text), ["L1", "M1", "M2", "M3"]);
  assert.equal(unified.filter((item) => item.source === "lancedb").length, 1);
  assert.equal(unified.filter((item) => item.source === "memos").length, 3);
});

test("buildUnifiedRecallResults supports different topK values while keeping balanced mixing", () => {
  const lancedbResults = [
    { text: "L1", score: 0.99, category: "fact", timestamp: 300 },
    { text: "L2", score: 0.98, category: "fact", timestamp: 290 },
    { text: "L3", score: 0.97, category: "fact", timestamp: 280 },
  ];
  const normalizedMemos = {
    textMem: [
      { text: "M1", score: 0.96, raw: { create_time: 295 } },
      { text: "M2", score: 0.95, raw: { create_time: 285 } },
      { text: "M3", score: 0.94, raw: { create_time: 275 } },
    ],
    prefMem: [],
    toolMem: [],
    skillMem: [],
    actMem: [],
    paraMem: [],
  };

  assert.deepEqual(
    buildUnifiedRecallResults(lancedbResults, normalizedMemos, { topK: 3 }).map((item) => item.text),
    ["L1", "M1", "L2"],
  );
  assert.deepEqual(
    buildUnifiedRecallResults(lancedbResults, normalizedMemos, { topK: 5 }).map((item) => item.text),
    ["L1", "M1", "L2", "M2", "L3"],
  );
});

test("buildUnifiedRecallResults keeps duplicate text from different sources", () => {
  const unified = buildUnifiedRecallResults(
    [
      { text: "同一段记忆", score: 0.9, category: "fact", timestamp: 101 },
    ],
    {
      textMem: [{ text: "同一段记忆", score: 0.89, raw: { create_time: 100 } }],
      prefMem: [],
      toolMem: [],
      skillMem: [],
      actMem: [],
      paraMem: [],
    },
    { topK: 4 },
  );

  assert.equal(unified.length, 2);
  assert.deepEqual(
    unified.map((item) => ({ source: item.source, text: item.text })),
    [
      { source: "lancedb", text: "同一段记忆" },
      { source: "memos", text: "同一段记忆" },
    ],
  );
});

test("buildUnifiedRecallResults includes tool skill act para memories in fallback order", () => {
  const unified = buildUnifiedRecallResults([], {
    textMem: [{ text: "文本记忆", score: 0.75, raw: { create_time: 110 } }],
    prefMem: [],
    toolMem: [{ text: "工具记忆", score: 0.65, raw: { create_time: 105 } }],
    skillMem: [{ text: "技能记忆", score: 0.64, raw: { create_time: 104 } }],
    actMem: [{ text: "动作记忆", score: 0.63, raw: { create_time: 103 } }],
    paraMem: [{ text: "参数记忆", score: 0.62, raw: { create_time: 102 } }],
  }, { topK: 6 });

  assert.deepEqual(
    unified.map((item) => item.type),
    ["text_mem", "tool_mem", "skill_mem", "act_mem", "para_mem"],
  );
});

test("summarizeUnifiedRecall respects topK and truncates preview text", () => {
  const preview = summarizeUnifiedRecall([
    { source: "lancedb", type: "fact", score: 0.9, text: "x".repeat(140) },
    { source: "memos", type: "text_mem", score: 0.8, text: "第二条" },
  ], 1);

  assert.equal(preview.length, 1);
  assert.equal(preview[0].text, "x".repeat(120));
});
