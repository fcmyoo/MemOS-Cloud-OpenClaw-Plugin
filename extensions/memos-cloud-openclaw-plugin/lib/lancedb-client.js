/**
 * LanceDB Storage Layer for MemOS Plugin
 * Provides vector + BM25 hybrid storage with multi-scope support
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Types
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
  "reflection",
];

/**
 * @typedef {Object} MemoryEntry
 * @property {string} id
 * @property {string} text
 * @property {number[]} vector
 * @property {string} category
 * @property {string} scope
 * @property {number} importance - 0.0 to 1.0
 * @property {number} timestamp - Unix ms
 * @property {string} [metadata] - JSON string for extensible fields
 */

/**
 * @typedef {Object} MemorySearchResult
 * @property {MemoryEntry} entry
 * @property {number} score
 * @property {{ vector?: { score: number, rank: number }, bm25?: { score: number, rank: number }, fused?: { score: number } }} sources
 */

// ============================================================================
// LanceDB Dynamic Import
// ============================================================================

let lancedbImportPromise = null;

export async function loadLanceDB() {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  return lancedbImportPromise;
}

// ============================================================================
// Storage Path Validation
// ============================================================================

/**
 * Validate and prepare the storage directory before LanceDB connection.
 */
export function validateStoragePath(dbPath) {
  if (!dbPath) {
    throw new Error("LanceDB dbPath is required");
  }

  // Expand ~ to home dir
  let resolvedPath = dbPath.startsWith("~/")
    ? join(homedir(), dbPath.slice(2))
    : dbPath;

  // Create directory if missing
  if (!existsSync(resolvedPath)) {
    try {
      mkdirSync(resolvedPath, { recursive: true });
    } catch (err) {
      throw new Error(
        `Failed to create LanceDB dbPath "${resolvedPath}": ${err.code || err.message}`,
      );
    }
  }

  // Check write permission
  try {
    accessSync(resolvedPath, constants.W_OK);
  } catch (err) {
    throw new Error(
      `LanceDB dbPath "${resolvedPath}" is not writable: ${err.code || err.message}`,
    );
  }

  return resolvedPath;
}

// ============================================================================
// Memory Store
// ============================================================================

const TABLE_NAME = "memories";

export class MemoryStore {
  /** @type {import("@lancedb/lancedb").Connection|null} */
  db = null;
  /** @type {import("@lancedb/lancedb").Table|null} */
  table = null;
  initPromise = null;
  ftsSupported = false;
  ftsIndexCreated = false;

  /**
   * @param {{ dbPath: string, vectorDim: number }} config
   */
  constructor(config) {
    this.config = config;
    this._vectorDim = config.vectorDim || 1024;
  }

  get vectorDim() {
    return this._vectorDim;
  }

  /** Ensure DB is initialized (idempotent) */
  async ensureInitialized() {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  async _doInitialize() {
    const lancedb = await loadLanceDB();

    let resolvedPath;
    try {
      resolvedPath = validateStoragePath(this.config.dbPath);
    } catch (err) {
      // If path validation fails, try as-is (might be a fresh path)
      resolvedPath = this.config.dbPath;
    }

    try {
      this.db = await lancedb.connect(resolvedPath);
    } catch (err) {
      throw new Error(
        `Failed to open LanceDB at "${resolvedPath}": ${err.code || err.message}`,
      );
    }

    // Idempotent table creation
    try {
      this.table = await this.db.openTable(TABLE_NAME);
    } catch {
      // Table doesn't exist, create it
      this.table = await this.db.createTable(TABLE_NAME, await this._schema());
    }

    // Check FTS support
    try {
      const version = this.db.engineVersion ? await this.db.engineVersion() : null;
      this.ftsSupported = Boolean(version);
    } catch {
      this.ftsSupported = false;
    }

    return;
  }

  async _schema() {
    const lancedb = await loadLanceDB();
    const { table, ...rest } = await lancedb;
    // Build schema dynamically based on what's available
    const fields = [
      lancedb.FixedSizeList(lancedb.Float32, this._vectorDim).createField("vector"),
    ];

    return new lancedb.ArenaBasedFixedSizeListBuilder(
      "memories",
      lancedb.FixedSizeList(lancedb.Float32, this._vectorDim).createField("vector"),
      16, // row group size
    );
  }

  /** Add a single memory entry */
  async add(entry) {
    await this.ensureInitialized();
    const lancedb = await loadLanceDB();

    const now = Date.now();
    const row = {
      id: entry.id || randomUUID(),
      text: entry.text,
      vector: entry.vector || new Array(this._vectorDim).fill(0),
      category: entry.category || "other",
      scope: entry.scope || "global",
      importance: entry.importance ?? 0.5,
      timestamp: entry.timestamp || now,
      metadata: entry.metadata || null,
    };

    await this.table.add([row]);
    return row;
  }

  /** Vector ANN search */
  async vectorSearch(vector, { limit = 10, scopeFilter } = {}) {
    await this.ensureInitialized();

    let query = this.table.vectorSearch(vector, {
      limit,
      ...(scopeFilter ? { prefilter: true } : {}),
    });

    if (scopeFilter) {
      // Apply scope filter post-query (LanceDB pre-filter on string columns)
      const all = await this.table
        .query()
        .where(`scope IN (${scopeFilter.map(s => `"${s}"`).join(",")})`)
        .limit(limit * 3)
        .toArray();

      // Re-rank by vector similarity
      const results = all
        .map((row) => ({
          entry: row,
          score: cosineSimilarity(vector, row.vector),
          sources: { vector: { score: cosineSimilarity(vector, row.vector), rank: 0 } },
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return results;
    }

    const results = await query.toArray();
    return results.map((row, rank) => ({
      entry: row,
      score: 1 - (row._distance ?? 0),
      sources: {
        vector: { score: 1 - (row._distance ?? 0), rank },
      },
    }));
  }

  /** BM25 full-text search using LanceDB FTS */
  async bm25Search(query, { limit = 10, scopeFilter } = {}) {
    await this.ensureInitialized();

    if (!this.ftsSupported) {
      // Fallback: naive text match
      return this._naiveTextSearch(query, { limit, scopeFilter });
    }

    try {
      let q = this.table.query();

      if (scopeFilter) {
        const scopeConditions = scopeFilter.map(s => `scope = "${s}"`).join(" OR ");
        q = q.where(scopeConditions);
      }

      const results = await q
        .limit(limit * 2)
        .toArray();

      const scored = results
        .map((row, rank) => ({
          entry: row,
          score: bm25Score(row.text || "", query),
          sources: { bm25: { score: bm25Score(row.text || "", query), rank } },
        }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return scored;
    } catch {
      return this._naiveTextSearch(query, { limit, scopeFilter });
    }
  }

  /** Naive fallback when FTS is unavailable */
  async _naiveTextSearch(query, { limit = 10, scopeFilter } = {}) {
    await this.ensureInitialized();

    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.length) return [];

    let q = this.table.query().limit(100);
    const results = await q.toArray();

    const filtered = results
      .filter((row) => {
        if (scopeFilter && !scopeFilter.includes(row.scope)) return false;
        const text = (row.text || "").toLowerCase();
        return keywords.some((kw) => text.includes(kw));
      })
      .map((row, rank) => ({
        entry: row,
        score: keywords.filter((kw) => (row.text || "").toLowerCase().includes(kw)).length / keywords.length,
        sources: { bm25: { score: keywords.filter((kw) => (row.text || "").toLowerCase().includes(kw)).length / keywords.length, rank } },
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return filtered;
  }

  /** Delete by IDs */
  async delete(ids) {
    await this.ensureInitialized();
    if (!ids || !ids.length) return;
    await this.table.delete(`id IN (${ids.map(id => `"${id}"`).join(",")})`);
  }

  /** Get stats */
  async stats() {
    await this.ensureInitialized();
    const total = await this.table.query().count();
    return { total };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/** Cosine similarity between two vectors */
export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Simple BM25 scoring */
function bm25Score(doc, query, k1 = 1.5, b = 0.75) {
  const docLen = doc.split(/\s+/).length;
  const avgLen = docLen; // Simplified: use doc itself as estimate
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  let score = 0;
  for (const term of keywords) {
    const termFreq = (doc.toLowerCase().match(new RegExp(term, "g")) || []).length;
    if (termFreq === 0) continue;
    // Simplified BM25: TF / (TF + k1 * (1 - b + b * docLen / avgLen))
    score += termFreq / (termFreq + k1 * (1 - b + b * docLen / Math.max(avgLen, 1)));
  }
  return score;
}

// ============================================================================
// Factory
// ============================================================================

/** Default DB path */
export function getDefaultDbPath() {
  return join(homedir(), ".openclaw", "memory", "memos-lancedb");
}
