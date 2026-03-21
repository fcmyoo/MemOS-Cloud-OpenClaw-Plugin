/**
 * LanceDB + MemOS Result Fusion
 * Merges LanceDB precision results with MemOS native recall results
 * into a unified prompt context block.
 */

import { USER_QUERY_MARKER } from "./memos-cloud-api.js";

// ============================================================================
// Fusion: Merge two result sets, deduplicate by text similarity
// ============================================================================

/**
 * Merge LanceDB results (precision-first) with MemOS results (knowledge-base).
 *
 * LanceDB results are prepended with high-priority markers to ensure they're
 * seen first by the LLM. MemOS results fill remaining slots.
 *
 * @param {Array} lancedbResults - LanceDBResult[] from LanceDBRetriever
 * @param {object} memosData - raw MemOS API response data
 * @param {{ topK?: number, lancedbPriority?: number }} options
 * @returns {string} - formatted prompt block
 */
export function mergeAndFormat(lancedbResults, memosData, options = {}) {
  const { topK = 6, lancedbPriority = 4 } = options;

  const lines = [];

  // ── Section 1: LanceDB Precision Memories ────────────────────────────────
  if (lancedbResults && lancedbResults.length > 0) {
    lines.push("<lancedb-precision>");
    lines.push("  <precision-facts>");

    const filtered = lancedbResults.slice(0, lancedbPriority);
    for (const r of filtered) {
      const time = formatTime(r.timestamp);
      const cat = r.category || "fact";
      const prefix = time ? `-[${time}]` : "";
      const text = sanitizeText(r.text || "", 300);
      lines.push(`     ${prefix}[${cat}] ${text}`);
    }

    lines.push("  </precision-facts>");
    lines.push("</lancedb-precision>");
    lines.push("");
  }

  // ── Section 2: MemOS Native Memories ─────────────────────────────────────
  if (memosData) {
    const memoryList = memosData.memory_detail_list || [];
    const preferenceList = memosData.preference_detail_list || [];

    if (memoryList.length > 0 || preferenceList.length > 0) {
      lines.push("<memories>");
      lines.push("  <facts>");

      for (const m of memoryList.slice(0, topK)) {
        const text = m.memory_value || m.memory_key || "";
        if (!text) continue;
        const time = formatTime(m.create_time);
        const prefix = time ? `-[${time}]` : "";
        lines.push(`     ${prefix} ${sanitizeText(text, 300)}`);
      }

      lines.push("  </facts>");
      lines.push("  <preferences>");

      for (const p of preferenceList.slice(0, 3)) {
        const text = p.preference || "";
        if (!text) continue;
        const type = normalizePreferenceType(p.preference_type);
        const typeLabel = type ? ` [${type}]` : "";
        lines.push(`     ${typeLabel} ${sanitizeText(text, 200)}`);
      }

      lines.push("  </preferences>");
      lines.push("</memories>");
    }

    // Tool memories (MemOS unique capability)
    const toolList = memosData.tool_memory_detail_list || [];
    if (toolList.length > 0) {
      lines.push("");
      lines.push("<tool-memories>");
      for (const t of toolList.slice(0, 3)) {
        const value = t.tool_value || "";
        if (!value) continue;
        lines.push(`  - ${sanitizeText(value, 200)}`);
      }
      lines.push("</tool-memories>");
    }
  }

  const block = lines.join("\n");
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

  const lines = [];
  lines.push("<precision-memories>");
  lines.push("  (High-precision memories from hybrid vector + BM25 retrieval with cross-encoder reranking)");

  for (const r of results.slice(0, topK)) {
    const time = formatTime(r.timestamp);
    const cat = r.category || "fact";
    const prefix = time ? `-[${time}]` : "";
    lines.push(`     ${prefix}[${cat}] ${sanitizeText(r.text || "", 300)}`);
  }

  lines.push("</precision-memories>");
  return lines.join("\n");
}

// ============================================================================
// Utilities
// ============================================================================

function sanitizeText(text, maxLen) {
  if (!text) return "";
  const cleaned = text.replace(/\r?\n+/g, " ").trim();
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
