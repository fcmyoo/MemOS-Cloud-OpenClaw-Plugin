import test from "node:test";
import assert from "node:assert/strict";
import plugin, {
  __resetTestSeamsForTests,
  __setTestSeamsForTests,
} from "../index.js";

process.env.MEMOS_API_KEY = "test-key";

function createApi(pluginConfig = {}) {
  const listeners = new Map();
  const logs = { info: [], warn: [] };
  return {
    pluginConfig,
    logger: {
      info: (line) => logs.info.push(line),
      warn: (line) => logs.warn.push(line),
    },
    config: {
      hooks: {
        internal: {
          enabled: false,
        },
      },
    },
    on(name, handler) {
      listeners.set(name, handler);
    },
    registerHook() {},
    listeners,
    logs,
  };
}

function createRetrieverStub(results) {
  return {
    async retrieve() {
      return {
        results,
        trace: { stages: [{ name: "final_filter", outputCount: results.length }] },
      };
    },
  };
}

function createMemosResult({ textMem = [] } = {}) {
  const memories = textMem.flatMap((bucket) => bucket.memories || []);
  return {
    data: {
      data: {
        memory_detail_list: memories.map((item) => ({
          memory_value: item.memory,
          relativity: item.relativity,
          create_time: item.create_time,
        })),
        preference_detail_list: [],
        tool_memory_detail_list: [],
        text_mem: textMem,
        pref_mem: [],
        tool_mem: [],
      },
    },
  };
}

function parseLogEntry(line) {
  const json = line.slice(line.indexOf("{"));
  return JSON.parse(json);
}

function parseInfoLogs(logs) {
  return logs.info
    .filter((line) => line.includes("{\"event\":"))
    .map(parseLogEntry);
}

async function runBeforeAgentStart({ pluginConfig, lancedbResults, memosResult }) {
  __resetTestSeamsForTests();
  __setTestSeamsForTests({
    createEmbedder: () => ({ embed: async () => [] }),
    createRetriever: () => createRetrieverStub(lancedbResults),
    searchMemory: async () => memosResult,
  });

  const api = createApi(pluginConfig);
  plugin.register(api);
  const handler = api.listeners.get("before_agent_start");
  assert.ok(handler);

  try {
    const result = await handler({ prompt: "帮我回忆一下之前的偏好" }, { sessionKey: "s-1", sessionId: "sid-1" });
    return { result, logs: api.logs };
  } finally {
    __resetTestSeamsForTests();
  }
}

test("buildRecallTrace shape is logged when recall succeeds", async () => {
  const { result, logs } = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
    },
    lancedbResults: [],
    memosResult: createMemosResult({
      textMem: [
        {
          cube_id: "text_mem",
          memories: [{ memory: "远端记忆", relativity: 0.66, create_time: 123 }],
        },
      ],
    }),
  });

  assert.ok(result?.prependContext.includes("远端记忆"));

  const success = parseInfoLogs(logs)
    .find((entry) => entry.event === "recall.success");

  assert.ok(success?.recall);
  assert.deepEqual(Object.keys(success.recall), ["lancedb", "fallback", "memos", "unified"]);
  assert.equal(success.recall.fallback.reason, "disabled");
  assert.equal(success.recall.fallback.lancedb_top_score, 0);
  assert.deepEqual(success.recall.memos.summary, {
    textMem: 1,
    prefMem: 0,
    toolMem: 0,
    skillMem: 0,
    actMem: 0,
    paraMem: 0,
  });
  assert.deepEqual(success.recall.unified.preview, [
    { source: "memos", type: "text_mem", score: 0.66, text: "远端记忆" },
  ]);
});

test("LanceDB-only unified preview remains consumable", async () => {
  const { result, logs } = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
      memosSearchFallbackEnabled: true,
      memosSearchFallbackMode: "weak-or-empty",
      memosSearchFallbackMinScore: 0.5,
      lancedb: {
        enabled: true,
        embedder: { apiKey: "embed-key" },
      },
    },
    lancedbResults: [
      { text: "仅本地记忆", score: 0.91, category: "fact", timestamp: 1710000000000 },
    ],
    memosResult: createMemosResult(),
  });

  assert.ok(result?.prependContext.includes("仅本地记忆"));

  const success = parseInfoLogs(logs)
    .find((entry) => entry.event === "recall.success");

  assert.ok(success?.recall);
  assert.deepEqual(Object.keys(success.recall), ["lancedb", "fallback", "memos", "unified"]);
  assert.equal(success.recall.fallback.reason, "strong_local_results");
  assert.equal(success.recall.fallback.lancedb_top_score, 0.91);
  assert.deepEqual(success.recall.memos.summary, {
    textMem: 0,
    prefMem: 0,
    toolMem: 0,
    skillMem: 0,
    actMem: 0,
    paraMem: 0,
  });
  assert.deepEqual(success.recall.unified.preview, [
    { source: "lancedb", type: "fact", score: 0.91, text: "仅本地记忆" },
  ]);
});
