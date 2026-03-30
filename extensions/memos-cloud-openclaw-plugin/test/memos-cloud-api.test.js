import test from "node:test";
import assert from "node:assert/strict";
import {
  USER_QUERY_MARKER,
  addMessage,
  buildConfig,
  formatPromptBlock,
  searchMemory,
} from "../lib/memos-cloud-api.js";


test("buildConfig uses aligned defaults and normalizes enums", () => {
  const cfg = buildConfig({
    conversationSuffixMode: "invalid-mode",
    captureStrategy: "unknown",
  }, { skipEnvFiles: true, env: {} });

  assert.equal(cfg.memoryLimitNumber, 5);
  assert.equal(cfg.conversationSuffixMode, "none");
  assert.equal(cfg.captureStrategy, "last_turn");
});

test("buildConfig clamps relativity to [0, 1]", () => {
  const opts = { skipEnvFiles: true, env: {} };
  const high = buildConfig({ relativity: 9 }, opts);
  const low = buildConfig({ relativity: -3 }, opts);
  const bad = buildConfig({ relativity: "abc" }, opts);

  assert.equal(high.relativity, 1);
  assert.equal(low.relativity, 0);
  assert.equal(bad.relativity, 0.45);
});

test("buildConfig applies memory stage1 explicit config and defaults", () => {
  const cfg = buildConfig({
    memoryTopK: 9,
    memorySearchTimeoutMs: 5001,
    memoryWriteRetry: 2,
  }, { skipEnvFiles: true, env: {} });
  assert.equal(cfg.memoryTopK, 9);
  assert.equal(cfg.memoryWriteRetry, 2);
  assert.equal(cfg.memorySearchTimeoutMs, 5001);
  assert.equal(cfg.memoryScopeMode, "hybrid");
  assert.equal(cfg.memoryDegradeOnError, true);
  assert.equal(cfg.memoryGrayPercent, 100);
});

test("buildConfig clamps memoryGrayPercent into [0, 100]", () => {
  const opts = { skipEnvFiles: true, env: {} };
  const high = buildConfig({ memoryGrayPercent: 999 }, opts);
  const low = buildConfig({ memoryGrayPercent: -1 }, opts);
  const ok = buildConfig({ memoryGrayPercent: 10 }, opts);
  assert.equal(high.memoryGrayPercent, 100);
  assert.equal(low.memoryGrayPercent, 0);
  assert.equal(ok.memoryGrayPercent, 10);
});

test("formatPromptBlock can read nested data.data payload", () => {
  const result = {
    data: {
      data: {
        memory_detail_list: [{ memory_value: "user likes concise answers", relativity: 0.9 }],
        preference_detail_list: [],
      },
    },
  };

  const block = formatPromptBlock(result, { relativity: 0.1 });
  assert.ok(block.includes("user likes concise answers"));
});

test("formatPromptBlock can read nested data.result payload", () => {
  const result = {
    data: {
      result: {
        memory_detail_list: [{ memory_value: "user prefers Chinese responses", relativity: 0.8 }],
        preference_detail_list: [],
      },
    },
  };

  const block = formatPromptBlock(result, { relativity: 0.1 });
  assert.ok(block.includes("user prefers Chinese responses"));
});

test("formatPromptBlock respects maxOutputChars budget", () => {
  const result = {
    data: {
      data: {
        memory_detail_list: [
          { memory_value: "A".repeat(1200), relativity: 0.95 },
          { memory_value: "B".repeat(1200), relativity: 0.94 },
        ],
        preference_detail_list: [],
      },
    },
  };
  const block = formatPromptBlock(result, { relativity: 0.1, maxOutputChars: 700 });
  assert.ok(block.length <= 700);
  assert.ok(block.includes(USER_QUERY_MARKER));
  assert.ok(block.endsWith(USER_QUERY_MARKER));
});

test("searchMemory uses /product/search with Token auth", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ code: 200, message: "ok", data: {} }),
    };
  };

  try {
    await searchMemory(
      {
        baseUrl: "https://df.jxpro.vip",
        apiKey: "token-123",
      },
      { user_id: "u1", query: "hello" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://df.jxpro.vip/product/search");
  assert.equal(calls[0].init?.headers?.Authorization, "Token token-123");
});

test("addMessage uses /product/add", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ code: 200, message: "ok", data: {} }),
    };
  };

  try {
    await addMessage(
      {
        baseUrl: "https://df.jxpro.vip",
        apiKey: "token-123",
      },
      { user_id: "u1", messages: [{ role: "user", content: "x" }], async_mode: "async" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://df.jxpro.vip/product/add");
});
