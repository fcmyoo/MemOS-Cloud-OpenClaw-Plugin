import test from "node:test";
import assert from "node:assert/strict";
import { getMemosFallbackDecision, shouldUseMemosSearchFallback } from "../lib/memos-fallback.js";

test("fallback disabled returns false", () => {
  assert.equal(shouldUseMemosSearchFallback({ memosSearchFallbackEnabled: false }, []), false);
});

test("empty-only fallback triggers on empty result set", () => {
  const cfg = { memosSearchFallbackEnabled: true, memosSearchFallbackMode: "empty-only" };
  assert.equal(shouldUseMemosSearchFallback(cfg, []), true);
  assert.equal(shouldUseMemosSearchFallback(cfg, [{ score: 0.1 }]), false);
});

test("weak-or-empty fallback triggers on weak top score", () => {
  const cfg = {
    memosSearchFallbackEnabled: true,
    memosSearchFallbackMode: "weak-or-empty",
    memosSearchFallbackMinScore: 0.45,
  };
  assert.equal(shouldUseMemosSearchFallback(cfg, []), true);
  assert.equal(shouldUseMemosSearchFallback(cfg, [{ score: 0.2 }]), true);
  assert.equal(shouldUseMemosSearchFallback(cfg, [{ score: 0.8 }]), false);
});

test("fallback decision returns reason and top score", () => {
  const cfg = {
    memosSearchFallbackEnabled: true,
    memosSearchFallbackMode: "weak-or-empty",
    memosSearchFallbackMinScore: 0.45,
  };
  assert.deepEqual(getMemosFallbackDecision(cfg, []), {
    shouldFallback: true,
    reason: "empty",
    topScore: 0,
  });
  assert.deepEqual(getMemosFallbackDecision(cfg, [{ score: 0.2 }]), {
    shouldFallback: true,
    reason: "weak_top_score",
    topScore: 0.2,
  });
});
