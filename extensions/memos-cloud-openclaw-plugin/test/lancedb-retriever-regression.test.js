import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/lancedb-client.js";
import { createRetriever } from "../lib/lancedb-retriever.js";

const DB_PATH = join(process.cwd(), ".tmp", "lancedb-retriever-regression");

const memoryVectors = {
  "用户偏好使用 tabs 而不是 spaces 来缩进代码": [1, 0, 0, 0, 0],
  "我们上个月决定用 PostgreSQL 而不是 MongoDB，因为需要事务支持": [0, 1, 0, 0, 0],
  "服务器 IP 是 124.156.198.237，运行在新加坡机房": [0, 0, 1, 0, 0],
  "上次 502 错误是因为 nginx proxy_read_timeout 设得太短": [0, 0, 0, 1, 0],
  "用户不喜欢电动牙刷，太吵了，还是喜欢手动刷牙": [0, 0, 0, 0, 1],
};

const fixtures = Object.entries(memoryVectors).map(([text, vector], idx) => ({
  id: `mem-${String(idx + 1).padStart(3, "0")}`,
  text,
  vector,
  scope: "global",
  category: ["preference", "decision", "fact", "fact", "preference"][idx],
  importance: 0.8,
  timestamp: Date.now() - idx * 1000,
}));

const cases = [
  ["用户代码缩进偏好是什么", [1, 0, 0, 0, 0], "mem-001", 1],
  ["数据库为什么选 PostgreSQL", [0, 1, 0, 0, 0], "mem-002", 1],
  ["服务器IP是什么", [0, 0, 1, 0, 0], "mem-003", 1],
  ["为什么会出现 502 错误", [0, 0, 0, 1, 0], "mem-004", 1],
  ["用户喜欢电动牙刷吗", [0, 0, 0, 0, 1], "mem-005", 1],
  ["今天中午吃了什么", [0.2, 0.2, 0.2, 0.2, 0.2], null, 0],
];

async function buildRetriever() {
  rmSync(DB_PATH, { recursive: true, force: true });
  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 5 });
  await store.ensureInitialized();
  for (const row of fixtures) {
    await store.add(row);
  }

  const embedder = {
    async embed(text) {
      const match = cases.find(([query]) => query === text);
      if (match) return match[1];
      return memoryVectors[text] || [0.2, 0.2, 0.2, 0.2, 0.2];
    },
  };

  return createRetriever({
    enabled: true,
    dbPath: DB_PATH,
    vectorDim: 5,
    candidatePoolSize: 10,
    topK: 4,
    minScore: 0.3,
    hardMinScore: 0.15,
    rerank: "none",
    filterNoise: true,
    minQueryLength: 2,
    recencyWeight: 0,
    lengthNormAnchor: 500,
  }, embedder);
}

test("retrieve regression: fixed 6-query suite", async () => {
  const retriever = await buildRetriever();

  for (const [query, _vector, expectedId, expectedCount] of cases) {
    const out = await retriever.retrieve(query, { scopeFilter: ["global"] });
    assert.equal(out.results.length, expectedCount, `unexpected result count for ${query}`);
    assert.equal(out.results[0]?.id ?? null, expectedId, `unexpected top id for ${query}`);
  }
});

test("shouldSkipQuery covers short, noise, and forced recall queries", async () => {
  const retriever = await buildRetriever();

  assert.equal(retriever.shouldSkipQuery("哈"), true);
  assert.equal(retriever.shouldSkipQuery("hi"), true);
  assert.equal(retriever.shouldSkipQuery("继续"), true);
  assert.equal(retriever.shouldSkipQuery("你还记得我之前说过什么"), false);
});

test("trace includes structured final_filter reasons", async () => {
  const retriever = await buildRetriever();

  const hit = await retriever.retrieve("用户代码缩进偏好是什么", { scopeFilter: ["global"] });
  const hitStage = hit.trace.stages.find((stage) => stage.name === "final_filter");
  assert.ok(hitStage);
  assert.equal(hitStage.reasons.pass_soft_score, 1);
  assert.equal(hitStage.keptPreview[0].filterReason, "pass_soft_score");
  assert.equal(hitStage.keptPreview[0].vectorScore, 1);

  const miss = await retriever.retrieve("今天中午吃了什么", { scopeFilter: ["global"] });
  const missStage = miss.trace.stages.find((stage) => stage.name === "final_filter");
  assert.ok(missStage);
  assert.equal(missStage.outputCount, 0);
  assert.ok(missStage.reasons.drop_weak_vector_only >= 1);
  assert.equal(missStage.droppedPreview[0].droppedReason, "drop_weak_vector_only");
});

test("final_filter covers hard/vector/bm25 pass and threshold drop branches", async () => {
  const retriever = await buildRetriever();
  const { kept, dropped, reasons } = retriever._applyFinalFilter([
    {
      id: "hard-pass",
      text: "hard pass",
      score: 0.2,
      sources: { vector: 0.8, bm25: 0 },
    },
    {
      id: "vector-floor",
      text: "vector floor",
      score: 0.1,
      sources: { vector: 0.8, bm25: 0 },
    },
    {
      id: "bm25-floor",
      text: "bm25 floor",
      score: 0.1,
      sources: { vector: 0.1, bm25: 0.5 },
    },
    {
      id: "drop-threshold",
      text: "drop threshold",
      score: 0.1,
      sources: { vector: 0, bm25: 0.1 },
    },
  ], 10);

  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((item) => item.filterReason), [
    "pass_hard_score",
    "pass_vector_floor",
    "pass_bm25_floor",
  ]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].droppedReason, "drop_below_threshold");
  assert.equal(reasons.pass_hard_score, 1);
  assert.equal(reasons.pass_vector_floor, 1);
  assert.equal(reasons.pass_bm25_floor, 1);
  assert.equal(reasons.drop_below_threshold, 1);
});
