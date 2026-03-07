import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig, formatPromptBlock } from "../lib/memos-cloud-api.js";

test("buildConfig uses aligned defaults and normalizes enums", () => {
  const cfg = buildConfig({
    conversationSuffixMode: "invalid-mode",
    captureStrategy: "unknown",
  });

  assert.equal(cfg.memoryLimitNumber, 6);
  assert.equal(cfg.conversationSuffixMode, "none");
  assert.equal(cfg.captureStrategy, "last_turn");
});

test("buildConfig clamps relativity to [0, 1]", () => {
  const high = buildConfig({ relativity: 9 });
  const low = buildConfig({ relativity: -3 });
  const bad = buildConfig({ relativity: "abc" });

  assert.equal(high.relativity, 1);
  assert.equal(low.relativity, 0);
  assert.equal(bad.relativity, 0.45);
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
