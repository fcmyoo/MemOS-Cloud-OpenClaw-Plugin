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
        trace: { stages: [] },
      };
    },
  };
}

function createMemosResult({
  memoryDetailList = [],
  preferenceDetailList = [],
  textMem = [],
  prefMem = [],
  toolMem = [],
} = {}) {
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

async function runBeforeAgentStart({
  pluginConfig,
  lancedbResults,
  memosResult,
  memosError,
  memosCalls,
}) {
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
  assert.ok(handler, "before_agent_start listener should be registered");

  try {
    return await handler(
      { prompt: "帮我回忆一下之前的偏好" },
      { sessionKey: "s-1", sessionId: "sid-1" },
    );
  } finally {
    __resetTestSeamsForTests();
  }
}

test("before_agent_start returns LanceDB-only precision block", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
      lancedb: {
        enabled: true,
        embedder: { apiKey: "embed-key" },
      },
    },
    lancedbResults: [
      { text: "本地命中：用户喜欢简洁回复", score: 0.92, category: "preference", timestamp: 1710000000000 },
    ],
    memosResult: createMemosResult(),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<precision-memories>"));
  assert.ok(result?.prependContext.includes("本地命中：用户喜欢简洁回复"));
  assert.equal(memosCalls.length, 0);
});

test("before_agent_start returns MemOS-only prompt block", async () => {
  const memosCalls = [];
  const result = await runBeforeAgentStart({
    pluginConfig: {
      apiKey: "token-123",
      memoryGrayPercent: 100,
    },
    lancedbResults: [],
    memosResult: createMemosResult({
      memoryDetailList: [
        { memory_value: "远端事实：用户常用中文", relativity: 0.9 },
      ],
      preferenceDetailList: [
        { preference: "远端偏好：先给结论", preference_type: "explicit_preference", relativity: 0.95 },
      ],
    }),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<memories>"));
  assert.ok(result?.prependContext.includes("远端事实：用户常用中文"));
  assert.ok(result?.prependContext.includes("远端偏好：先给结论"));
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
      lancedb: {
        enabled: true,
        embedder: { apiKey: "embed-key" },
      },
    },
    lancedbResults: [
      { text: "本地事实：用户偏好结构化输出", score: 0.6, category: "fact", timestamp: 1710000000000 },
    ],
    memosResult: createMemosResult({
      memoryDetailList: [
        { memory_value: "远端事实：用户项目使用 OpenClaw", relativity: 0.88 },
      ],
      textMem: [
        {
          cube_id: "text_mem",
          memories: [{ memory: "远端统一召回：OpenClaw 项目", relativity: 0.88 }],
        },
      ],
      prefMem: [
        {
          cube_id: "pref_mem",
          memories: [{ preference: "远端统一偏好：结论优先", relativity: 0.8 }],
        },
      ],
    }),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<lancedb-precision>"));
  assert.ok(result?.prependContext.includes("<unified-recall>"));
  assert.ok(result?.prependContext.includes("<memories>"));
  assert.ok(result?.prependContext.includes("本地事实：用户偏好结构化输出"));
  assert.ok(result?.prependContext.includes("远端统一召回：OpenClaw 项目"));
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
      lancedb: {
        enabled: true,
        embedder: { apiKey: "embed-key" },
      },
    },
    lancedbResults: [
      { text: "本地弱命中", score: 0.2, category: "fact", timestamp: 1710000000000 },
    ],
    memosResult: createMemosResult({
      memoryDetailList: [
        { memory_value: "远端补充命中", relativity: 0.9 },
      ],
      textMem: [
        {
          cube_id: "text_mem",
          memories: [{ memory: "远端补充命中", relativity: 0.9 }],
        },
      ],
    }),
    memosCalls,
  });

  assert.ok(result?.prependContext.includes("<lancedb-precision>"));
  assert.ok(result?.prependContext.includes("<unified-recall>"));
  assert.ok(result?.prependContext.includes("远端补充命中"));
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
      lancedb: {
        enabled: true,
        embedder: { apiKey: "embed-key" },
      },
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
