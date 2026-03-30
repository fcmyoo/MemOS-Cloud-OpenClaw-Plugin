/**
 * LanceDB + MemOS Result Fusion
 * Merges LanceDB precision results with MemOS native recall results
 * into a unified prompt context block.
 */

// ============================================================================
// Fusion: Merge result sets, deduplicate by normalized text
// ============================================================================

/**
 * Merge LanceDB results (precision-first) with MemOS results (knowledge-base).
 *
 * Final output is constrained to a single <recall> block; no legacy
 * precision/unified/memories blocks or parallel tool/skill side blocks.
 *
 * @param {Array} lancedbResults - LanceDBResult[] from LanceDBRetriever
 * @param {object} memosData - raw MemOS API response data
 * @param {{ topK?: number, lancedbPriority?: number }} options
 * @returns {string} - formatted prompt block
 */
export function mergeAndFormat(lancedbResults, memosData, options = {}) {
  const { topK = 6, lancedbPriority = 4, normalizedMemos = null, unifiedResults = null } = options;

  const lines = [];
  const textMem = normalizedMemos?.textMem || [];
  const prefMem = normalizedMemos?.prefMem || [];
  const toolMem = normalizedMemos?.toolMem || [];
  const skillMem = normalizedMemos?.skillMem || [];
  const unified = Array.isArray(unifiedResults) ? unifiedResults : [];

  // NOTE: <lancedb-precision> and <unified-recall> removed — content already
  // covered by the single <recall> block below (collectPrimaryRecallItems).
  // This avoids duplicate blocks in the prompt context.

  const recallItems = collectPrimaryRecallItems({
    lancedbResults,
    memosData,
    unifiedResults: unified,
    textMem,
    prefMem,
    topK,
  });

  const mergedToolMem = dedupeTextEntries(
    toolMem.length > 0
      ? toolMem.map((item) => item.text)
      : (memosData?.tool_memory_detail_list || []).map((item) => item.tool_value || "").filter(Boolean),
  );
  for (const value of mergedToolMem.slice(0, 3)) {
    recallItems.push({
      source: "memos",
      type: "tool_mem",
      timestamp: 0,
      text: value,
    });
  }

  const mergedSkillMem = dedupeTextEntries(skillMem.map((item) => item.text));
  for (const value of mergedSkillMem.slice(0, 3)) {
    recallItems.push({
      source: "memos",
      type: "skill_mem",
      timestamp: 0,
      text: value,
    });
  }

  const finalRenderedItems = dedupeTextEntries(
    recallItems.map((item) => formatRecallItem(item)).filter(Boolean),
  );

  const block = finalRenderedItems.length > 0
    ? ["", "<recall>", ...finalRenderedItems.map((item) => `  - ${item}`), "</recall>"].join("\n")
    : "";
  return block || "";
}

// ============================================================================
// Format LanceDB results as a standalone precision block
// ============================================================================

/**
 * Format LanceDB-only results as a prompt block (for when MemOS returns nothing).
 * @param {Array} results
 * @param {{ topK?: number }} options
 * @returns {string}
 */
export function formatLanceDBOnly(results, options = {}) {
  const { topK = 4 } = options;
  if (!results || !results.length) return "";

  const recallItems = dedupeByNormalizedText(results).slice(0, topK).map((item) => ({
    source: "lancedb",
    type: item.category || "fact",
    timestamp: item.timestamp || 0,
    text: item.text || "",
  }));

  const renderedItems = recallItems
    .map((item) => formatRecallItem(item))
    .filter(Boolean);
  if (renderedItems.length === 0) return "";

  const lines = [];
  lines.push("<recall>");
  for (const item of renderedItems) {
    lines.push(`  - ${item}`);
  }
  lines.push("</recall>");
  return lines.join("\n");
}

function collectPrimaryRecallItems({
  lancedbResults = [],
  memosData = null,
  unifiedResults = [],
  textMem = [],
  prefMem = [],
  topK = 6,
}) {
  if (unifiedResults.length > 0) {
    return dedupeByNormalizedText(unifiedResults).slice(0, topK).map((item) => ({
      source: item.source || "unknown",
      type: item.type || "fact",
      timestamp: item.timestamp || item.raw?.create_time || item.raw?.timestamp || 0,
      text: item.text || "",
    }));
  }

  const fallback = [];

  for (const item of dedupeByNormalizedText(lancedbResults)) {
    fallback.push({
      source: "lancedb",
      type: item.category || "fact",
      timestamp: item.timestamp || 0,
      text: item.text || "",
    });
  }

  for (const item of dedupeByNormalizedText(textMem)) {
    fallback.push({
      source: item.source || "memos",
      type: item.type || "text_mem",
      timestamp: item.raw?.create_time || item.raw?.timestamp || 0,
      text: item.text || "",
    });
  }

  for (const item of dedupeByNormalizedText(prefMem)) {
    fallback.push({
      source: item.source || "memos",
      type: item.type || "pref_mem",
      timestamp: item.raw?.create_time || item.raw?.timestamp || 0,
      text: item.text || "",
    });
  }

  if (fallback.length > 0) {
    return dedupeByNormalizedText(fallback).slice(0, topK);
  }

  const memoryList = Array.isArray(memosData?.memory_detail_list) ? memosData.memory_detail_list : [];
  const preferenceList = Array.isArray(memosData?.preference_detail_list) ? memosData.preference_detail_list : [];
  const rawFallback = [];

  for (const item of memoryList) {
    const text = item.memory_value || item.memory_key || "";
    if (!text) continue;
    rawFallback.push({
      source: "memos",
      type: "text_mem",
      timestamp: item.create_time || 0,
      text,
    });
  }

  for (const item of preferenceList) {
    const text = item.preference || "";
    if (!text) continue;
    rawFallback.push({
      source: "memos",
      type: normalizePreferenceType(item.preference_type) || "pref_mem",
      timestamp: item.create_time || 0,
      text,
    });
  }

  return dedupeByNormalizedText(rawFallback).slice(0, topK);
}

function formatRecallItem(item) {
  const source = item.source || "unknown";
  const type = item.type || "fact";
  const text = sanitizeText(item.text, 300);
  if (!text) return "";
  return `[${source}/${type}] ${text}`.trim();
}

function dedupeTextEntries(values = []) {
  const seen = new Set();
  const deduped = [];
  for (const value of values) {
    const text = sanitizeText(value, 1000);
    const key = normalizeTextKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(text);
  }
  return deduped;
}

function dedupeByNormalizedText(items = []) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const text = item?.text || "";
    const key = normalizeTextKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function normalizeTextKey(text) {
  if (!text) return "";
  return String(text)
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ============================================================================
// Utilities
// ============================================================================

function sanitizeText(text, maxLen) {
  if (!text) return "";

  let cleaned = String(text)
    .replace(/```json[\s\S]*?```/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<\/?(?:precision-memories|unified-recall|memories)>/gi, " ")
    .replace(/\(High-precision memories from hybrid vector \+ BM25 retrieval with cross-encoder reranking\)/gi, " ")
    .replace(/Conversation info\s*\(untrusted metadata\)\s*:/gi, " ")
    .replace(/Sender\s*\(untrusted metadata\)\s*:/gi, " ")
    .replace(/\bJSON metadata\b\s*:/gi, " ")
    .replace(/\{\s*"(?:message_id|sender_id|sender|timestamp|label|id|name|username)"[\s\S]*?\}/gi, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const previous = new Set();
  while (cleaned && !previous.has(cleaned)) {
    previous.add(cleaned);
    cleaned = cleaned
      .replace(/^[-•*]\s*[-•*]\s*(?=\[)/, "")
      .replace(/^[-•*]\s+(?=-\[)/, "")
      .replace(/^-\s*-\[/, "-[")
      .replace(/^[-•*]\s*/, "")
      .replace(/^(?:-\[[0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}\]\[[^\]]+\]\s*)+/, "")
      .replace(/^(?:\[[^\]]+\]\[[^\]]+\]\s*)+/, "")
      .replace(/^[:：,，;；\-\s]+/, "")
      .trim();
  }

  cleaned = cleaned
    .replace(/[：:，,;；\-]\s*-\[[0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}\]\[[^\]]+\]\s*/g, " ")
    .replace(/\s+-\[[0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}\]\[[^\]]+\]\s*/g, " ")
    .replace(/[：:，,;；]\s*\[[^\]]+\]\[[^\]]+\]\s*/g, " ")
    .replace(/\s+\[[^\]]+\]\[[^\]]+\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/^\[[^\]]+\]\s*$/.test(cleaned) || /^-\[[^\]]+\]\s*$/.test(cleaned)) {
    return "";
  }

  if (cleaned.length > maxLen) {
    return cleaned.slice(0, maxLen) + "...";
  }
  return cleaned;
}

function formatTime(timestamp) {
  if (!timestamp || timestamp <= 0) return "";
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return "";
  }
}

function normalizePreferenceType(value) {
  if (!value) return "";
  const normalized = String(value).toLowerCase();
  if (normalized.includes("explicit")) return "Explicit Preference";
  if (normalized.includes("implicit")) return "Implicit Preference";
  return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
