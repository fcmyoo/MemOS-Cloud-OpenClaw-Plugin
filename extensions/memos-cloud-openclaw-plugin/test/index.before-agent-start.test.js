import test from "node:test";
import assert from "node:assert/strict";
import plugin, {
  __resetTestSeamsForTests,
  __setTestSeamsForTests,
} from "../index.js";

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
      hooks: { internal: { enabled: false } },
    },
    on(name, handler) {
      listeners.set(name, handler);
    },
    registerHook() {},
    listeners,
    logs,
  };
}

function createRetrieverStub(results, trace = { stages: [] }) {
  return {
    async retrieve() {
      return { results, trace };
    },
  };
}

function createMemosResult({ memoryDetailList = [], preferenceDetailList = [], textMem = [], prefMem = [], toolMem = [] } = {}) {
  return {
    data: {
      data: {
        memory_detail_list: memoryDetailList,
        preference_detail_list: preferenceDetailList,
        tool_memory_detail_list: [],
        text_mem: textMem,
        pref_mem: prefMem,
        tool_mem: toolMem,
      },
    },
  };
}

async function runBeforeAgentStart({ pluginConfig, lancedbResults, memosResult, memosError, memosCalls }) {
  __resetTestSeamsForTests();
  __setTestSeamsForTests({
    createEmbedder: () => ({ embed: async () => [] }),
    createRetriever: () => createRetrieverStub(lancedbResults),
    searchMemory: async (_cfg, payload) => {
      memosCalls.push(payload);
      if (memosError) throw memosError;
      return memosResult;
    },
  });

  const api = createApi(pluginConfig);
  plugin.register(api);
  const handler = api.listeners.get("before_agent_start");
  assert.ok(handler);

  try {
    return await handler(
      { prompt: "help me remember prior preferences" },
      { sessionKey: "s-1", sessionId: "sid-1" },
    );
  } finally {
    __resetTestSeamsForTests();
  }
}

test("before_agent_start returns LanceDB-only recall block", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
      lancedb: { enabled: true, embedder: { apiKey: "embed-key" } },
    },
    lancedbResults: [
      { text: "local hit: user prefers concise replies", score: 0.92, category: "preference", timestamp: 1710000000000 },
    ],
    memosResult: createMemosResult(),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<recall>"));
  assert.ok(result?.prependContext.includes("local hit: user prefers concise replies"));
  assert.equal(memosCalls.length, 0);
});

test("before_agent_start returns MemOS-only recall block", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
    },
    lancedbResults: [],
    memosResult: createMemosResult({
      memoryDetailList: [{ memory_value: "remote fact: user often uses Chinese", relativity: 0.9 }],
      preferenceDetailList: [{ preference: "remote preference: give conclusion first", preference_type: "explicit_preference", relativity: 0.95 }],
    }),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<recall>"));
  assert.ok(result?.prependContext.includes("remote fact: user often uses Chinese"));
  assert.ok(result?.prependContext.includes("remote preference: give conclusion first"));
  assert.equal(memosCalls.length, 1);
});

test("before_agent_start merges LanceDB and MemOS when both are available", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
      memosSearchFallbackEnabled: true,
      memosSearchFallbackMode: "weak-or-empty",
      memosSearchFallbackMinScore: 0.95,
      lancedb: { enabled: true, embedder: { apiKey: "embed-key" } },
    },
    lancedbResults: [
      { text: "local fact: user prefers structured output", score: 0.6, category: "fact", timestamp: 1710000000000 },
    ],
    memosResult: createMemosResult({
      textMem: [{ cube_id: "text_mem", memories: [{ memory: "remote project uses OpenClaw", relativity: 0.88 }] }],
      prefMem: [{ cube_id: "pref_mem", memories: [{ preference: "remote preference: lead with conclusion", relativity: 0.8 }] }],
    }),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<recall>"));
  assert.ok(result?.prependContext.includes("local fact: user prefers structured output"));
  assert.ok(result?.prependContext.includes("remote project uses OpenClaw"));
  assert.equal(memosCalls.length, 1);
});

test("before_agent_start falls back to MemOS on weak LanceDB hit", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
      memosSearchFallbackEnabled: true,
      memosSearchFallbackMode: "weak-or-empty",
      memosSearchFallbackMinScore: 0.5,
      lancedb: { enabled: true, embedder: { apiKey: "embed-key" } },
    },
    lancedbResults: [
      { text: "weak local hit", score: 0.2, category: "fact", timestamp: 1710000000000 },
    ],
    memosResult: createMemosResult({
      textMem: [{ cube_id: "text_mem", memories: [{ memory: "remote fallback hit", relativity: 0.9 }] }],
    }),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<recall>"));
  assert.ok(result?.prependContext.includes("remote fallback hit"));
  assert.equal(memosCalls.length, 1);
});

test("before_agent_start returns nothing on fallback miss", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
      memosSearchFallbackEnabled: true,
      memosSearchFallbackMode: "empty-only",
      lancedb: { enabled: true, embedder: { apiKey: "embed-key" } },
    },
    lancedbResults: [],
    memosResult: createMemosResult(),
    memosCalls,
  });

  assert.equal(result, undefined);
  assert.equal(memosCalls.length, 1);
});

test("before_agent_start degrades on MemOS error when degrade is enabled", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
      memoryDegradeOnError: true,
    },
    lancedbResults: [],
    memosError: new Error("MemOS boom"),
    memosCalls,
  });

  assert.equal(result, undefined);
  assert.equal(memosCalls.length, 1);
});
