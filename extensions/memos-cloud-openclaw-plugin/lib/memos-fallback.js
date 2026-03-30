export function getMemosFallbackDecision(cfg, lancedbResults = []) {
  if (!cfg?.memosSearchFallbackEnabled) {
    return { shouldFallback: false, reason: "disabled", topScore: 0 };
  }

  const mode = cfg.memosSearchFallbackMode || "empty-only";
  const topScore = Array.isArray(lancedbResults) && lancedbResults.length > 0
    ? Number(lancedbResults[0]?.score ?? 0)
    : 0;

  if (!Array.isArray(lancedbResults) || lancedbResults.length === 0) {
    return { shouldFallback: true, reason: "empty", topScore };
  }

  if (mode === "weak-or-empty" && topScore < (cfg.memosSearchFallbackMinScore ?? 0.45)) {
    return { shouldFallback: true, reason: "weak_top_score", topScore };
  }

  return { shouldFallback: false, reason: "strong_local_results", topScore, memos_called: false };
}

export function shouldUseMemosSearchFallback(cfg, lancedbResults = []) {
  return getMemosFallbackDecision(cfg, lancedbResults).shouldFallback;
}
