import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/lancedb-client.js";
import { createRetriever } from "../lib/lancedb-retriever.js";

const DB_PATH = join(process.cwd(), ".tmp", "lancedb-retriever-regression-script");
rmSync(DB_PATH, { recursive: true, force: true });

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

const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 5 });
await store.ensureInitialized();
for (const row of fixtures) await store.add(row);

const embedder = {
  async embed(text) {
    const match = cases.find(([query]) => query === text);
    if (match) return match[1];
    return memoryVectors[text] || [0.2, 0.2, 0.2, 0.2, 0.2];
  },
};

const retriever = createRetriever({
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

let passed = 0;
for (const [query, _vector, expectedId, expectedCount] of cases) {
  const out = await retriever.retrieve(query, { scopeFilter: ["global"] });
  const ok = out.results.length === expectedCount && (out.results[0]?.id ?? null) === expectedId;
  if (ok) passed += 1;
  console.log(`\n=== ${query} ===`);
  console.log(JSON.stringify({
    ok,
    expectedId,
    actualId: out.results[0]?.id ?? null,
    count: out.results.length,
    finalFilter: out.trace.stages.find((s) => s.name === "final_filter") || null,
  }, null, 2));
}

console.log(`\nPASS ${passed}/${cases.length}`);
if (passed !== cases.length) process.exit(1);
