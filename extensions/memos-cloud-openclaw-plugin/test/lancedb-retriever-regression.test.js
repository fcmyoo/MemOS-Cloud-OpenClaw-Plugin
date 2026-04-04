import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/lancedb-client.js";
import { createRetriever } from "../lib/lancedb-retriever.js";

const DB_PATH = join(process.cwd(), ".tmp", "lancedb-retriever-regression");

const memoryVectors = {
  "user prefers tabs over spaces": [1, 0, 0, 0, 0],
  "team decided to use PostgreSQL instead of MongoDB": [0, 1, 0, 0, 0],
  "server ip is 124.156.198.237": [0, 0, 1, 0, 0],
  "last 502 error was caused by short nginx timeout": [0, 0, 0, 1, 0],
  "user dislikes electric toothbrushes": [0, 0, 0, 0, 1],
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
  ["what indentation does the user prefer", [1, 0, 0, 0, 0], "mem-001", 1],
  ["why did the team choose PostgreSQL", [0, 1, 0, 0, 0], "mem-002", 1],
  ["what is the server ip", [0, 0, 1, 0, 0], "mem-003", 1],
  ["what caused the 502 error", [0, 0, 0, 1, 0], "mem-004", 1],
  ["does the user like electric toothbrushes", [0, 0, 0, 0, 1], "mem-005", 1],
  ["what did the user eat for lunch today", [0.2, 0.2, 0.2, 0.2, 0.2], null, 0],
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
    minScore: 0.005,
    hardMinScore: 0.005,
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
    assert.ok(out.results.length >= expectedCount, `unexpected result count for ${query}`);
    if (expectedId) {
      assert.ok(out.results.length > 0, `expected at least one relevant result for ${query}`);
    }
  }
});

test("shouldSkipQuery covers short, noise, and forced recall queries", async () => {
  const retriever = await buildRetriever();

  assert.equal(retriever.shouldSkipQuery("ok"), true);
  assert.equal(retriever.shouldSkipQuery("hi"), true);
  assert.equal(retriever.shouldSkipQuery("continue"), true);
  assert.equal(retriever.shouldSkipQuery("what do you remember about my preferences"), false);
});

test("trace includes rrf_fusion stage for hit and miss cases", async () => {
  const retriever = await buildRetriever();

  const hit = await retriever.retrieve("what indentation does the user prefer", { scopeFilter: ["global"] });
  const hitStage = hit.trace.stages.find((stage) => stage.name === "rrf_fusion");
  assert.ok(hitStage);
  assert.ok(hitStage.inputCount >= 1);
  assert.ok(hitStage.outputCount >= 1);

  const miss = await retriever.retrieve("what did the user eat for lunch today", { scopeFilter: ["global"] });
  const missStage = miss.trace.stages.find((stage) => stage.name === "rrf_fusion");
  assert.ok(missStage);
  assert.ok(missStage.inputCount >= 0);
  assert.ok(missStage.outputCount >= 0);
});

test("trace continues through mmr_diversity after rrf_fusion", async () => {
  const retriever = await buildRetriever();
  const out = await retriever.retrieve("what indentation does the user prefer", { scopeFilter: ["global"] });
  const fusionStage = out.trace.stages.find((stage) => stage.name === "rrf_fusion");
  const mmrStage = out.trace.stages.find((stage) => stage.name === "mmr_diversity");

  assert.ok(fusionStage);
  assert.ok(mmrStage);
  assert.ok(mmrStage.inputCount <= fusionStage.outputCount);
  assert.ok(mmrStage.outputCount <= 4);
});
