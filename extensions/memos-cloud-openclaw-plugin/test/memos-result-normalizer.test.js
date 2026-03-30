import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMemosSearchResult } from "../lib/memos-result-normalizer.js";

test("normalizeMemosSearchResult reads memos-memory style buckets", () => {
  const result = {
    data: {
      data: {
        text_mem: [{ cube_id: "u1", memories: [{ memory: "用户喜欢川菜", relativity: 0.9 }] }],
        pref_mem: [{ cube_id: "u1", memories: [{ memory: "偏好辣", relativity: 0.8 }] }],
        tool_mem: [{ cube_id: "u1", memories: [{ tool_value: "使用 ffmpeg", relativity: 0.7 }] }],
        skill_mem: [{ cube_id: "u1", memories: [{ memory: "熟悉 nginx 超时排查", relativity: 0.6 }] }],
      },
    },
  };

  const normalized = normalizeMemosSearchResult(result);
  assert.equal(normalized.textMem.length, 1);
  assert.equal(normalized.prefMem.length, 1);
  assert.equal(normalized.toolMem.length, 1);
  assert.equal(normalized.skillMem.length, 1);
  assert.equal(normalized.summary.textMem, 1);
  assert.equal(normalized.textMem[0].text, "用户喜欢川菜");
});

test("normalizeMemosSearchResult covers response shape matrix", () => {
  const cases = [
    {
      name: "data.data",
      input: {
        data: {
          data: {
            text_mem: [{ cube_id: "t1", memories: [{ memory: "文本记忆", relativity: 0.9 }] }],
          },
        },
      },
      check(normalized) {
        assert.equal(normalized.textMem.length, 1);
        assert.equal(normalized.textMem[0].cubeId, "t1");
      },
    },
    {
      name: "data.result",
      input: {
        data: {
          result: {
            pref_mem: [{ cube_id: "p1", memories: [{ preference: "偏好咖啡", score: 0.8 }] }],
          },
        },
      },
      check(normalized) {
        assert.equal(normalized.prefMem.length, 1);
        assert.equal(normalized.prefMem[0].text, "偏好咖啡");
      },
    },
    {
      name: "result",
      input: {
        result: {
          tool_mem: [{ cube_id: "tool1", memories: [{ tool_value: "使用 curl", score: 0.7 }] }],
        },
      },
      check(normalized) {
        assert.equal(normalized.toolMem.length, 1);
        assert.equal(normalized.toolMem[0].text, "使用 curl");
      },
    },
    {
      name: "act_mem",
      input: {
        result: {
          act_mem: [{ cube_id: "act1", memories: [{ memory_value: "已执行发布", score: 0.6 }] }],
        },
      },
      check(normalized) {
        assert.equal(normalized.actMem.length, 1);
        assert.equal(normalized.actMem[0].type, "act_mem");
        assert.equal(normalized.actMem[0].text, "已执行发布");
      },
    },
    {
      name: "para_mem",
      input: {
        result: {
          para_mem: [{ cube_id: "para1", memories: [{ memory: "参数已调整", score: 0.5 }] }],
        },
      },
      check(normalized) {
        assert.equal(normalized.paraMem.length, 1);
        assert.equal(normalized.paraMem[0].type, "para_mem");
        assert.equal(normalized.paraMem[0].text, "参数已调整");
      },
    },
    {
      name: "empty bucket",
      input: {
        result: {
          text_mem: [{ cube_id: "empty", memories: [] }],
          pref_mem: [{ cube_id: "empty", memories: [] }],
        },
      },
      check(normalized) {
        assert.equal(normalized.textMem.length, 0);
        assert.equal(normalized.prefMem.length, 0);
        assert.deepEqual(normalized.summary, {
          textMem: 0,
          prefMem: 0,
          toolMem: 0,
          skillMem: 0,
          actMem: 0,
          paraMem: 0,
        });
      },
    },
  ];

  for (const { name, input, check } of cases) {
    const normalized = normalizeMemosSearchResult(input);
    check(normalized);
    assert.ok(normalized.summary);
  }
});
