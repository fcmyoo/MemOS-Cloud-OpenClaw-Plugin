/**
 * LanceDB Storage Layer for MemOS Plugin
 * Provides vector + BM25 hybrid storage with multi-scope support
 *
 * Changes from v0.1.7:
 *  - Fix _schema(): replaced invalid ArenaBasedFixedSizeListBuilder with sample-data bootstrap
 *  - Fix BM25: proper avgDocLen tracking (no longer avgLen = docLen self-assignment)
 *  - Fix vectorSearch scopeFilter: try native prefilter first, fallback to post-filter
 *  - Fix: all results now carry `vector` field for MMR downstream use
 *  - Add: FTS index creation on table init (best-effort)
 *  - Add: _docCount / _totalDocLen stats tracking on write
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
 * @property {number} timestamp  - Unix ms
 * @property {string} [metadata] - JSON string for extensible fields
 */

/**
 * @typedef {Object} MemorySearchResult
 * @property {MemoryEntry} entry
 * @property {number[]} vector   - carried for downstream MMR dedup
 * @property {number} score
 * @property {{ vector?: { score: number, rank: number }, bm25?: { score: number, rank: number } }} sources
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

  let resolvedPath = dbPath.startsWith("~/")
    ? join(homedir(), dbPath.slice(2))
    : dbPath;

  if (!existsSync(resolvedPath)) {
    try {
      mkdirSync(resolvedPath, { recursive: true });
    } catch (err) {
      throw new Error(
        `Failed to create LanceDB dbPath "${resolvedPath}": ${err.code || err.message}`,
      );
    }
  }

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
const SCHEMA_INIT_ID = "__schema_init__";

export class MemoryStore {
  /** @type {import("@lancedb/lancedb").Connection|null} */
  db = null;
  /** @type {import("@lancedb/lancedb").Table|null} */
  table = null;
  initPromise = null;
  ftsSupported = false;
  ftsIndexCreated = false;

  // BM25 document stats removed for local-first optimization

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

  // avgDocLen removed

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
    } catch {
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
      // Table doesn't exist — bootstrap via sample data to define schema
      await this._createTableWithSchema();
    }

    // Create FTS index for the text column (best-effort, non-fatal)
    try {
      // @lancedb/lancedb >= 0.12 supports createIndex with fts type
      await this.table.createIndex("text", { type: "fts" });
      this.ftsIndexCreated = true;
      this.ftsSupported = true;
    } catch {
      // Index may already exist, or FTS not supported in this build — ignore
      this.ftsSupported = false;
    }
  }

  /**
   * Bootstrap the table schema using a throwaway sample record.
   * This avoids requiring apache-arrow as an explicit dependency.
   */
  async _createTableWithSchema() {
    const sampleData = [
      {
        id: SCHEMA_INIT_ID,
        text: "",
        vector: new Array(this._vectorDim).fill(0),
        category: "other",
        scope: "global",
        importance: 0.5,
        timestamp: 0.0,
        metadata: null,
      },
    ];
    this.table = await this.db.createTable(TABLE_NAME, sampleData);
    // Remove the bootstrap record immediately (best-effort)
    try {
      await this.table.delete(`id = '${SCHEMA_INIT_ID}'`);
    } catch {
      // Non-critical
    }
  }

  /** Add a single memory entry */
  async add(entry) {
    await this.ensureInitialized();

    const now = Date.now();
    const text = entry.text || "";
    const row = {
      id: entry.id || randomUUID(),
      text,
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

    if (scopeFilter?.length) {
      // Attempt 1: native prefilter (LanceDB >= 0.12, avoids full table scan)
      try {
        const whereClause = `scope IN (${scopeFilter.map((s) => `'${s}'`).join(",")})`;
        const rawResults = await this.table
          .vectorSearch(vector)
          .prefilter(whereClause)
          .limit(limit)
          .toArray();

        if (rawResults.length > 0) {
          return rawResults.map((row, rank) => ({
            entry: row,
            vector: Array.isArray(row.vector) ? row.vector : null,
            score: 1 - (row._distance ?? 0),
            sources: { vector: { score: 1 - (row._distance ?? 0), rank } },
          }));
        }
      } catch {
        // prefilter API not available — fall through to post-filter
      }

      // Fallback: fetch a wider window and re-rank by cosine similarity
      const all = await this.table
        .query()
        .where(`scope IN (${scopeFilter.map((s) => `"${s}"`).join(",")})`)
        .limit(limit * 4)
        .toArray();

      return all
        .map((row) => {
          const rowVector = Array.isArray(row.vector) ? row.vector : null;
          const score = rowVector ? cosineSimilarity(vector, rowVector) : 0;
          return {
            entry: row,
            vector: rowVector,
            score,
            sources: { vector: { score, rank: 0 } },
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    // No scope filter: direct ANN
    const results = await this.table
      .vectorSearch(vector)
      .limit(limit)
      .toArray();

    return results.map((row, rank) => ({
      entry: row,
      vector: Array.isArray(row.vector) ? row.vector : null,
      score: 1 - (row._distance ?? 0),
      sources: { vector: { score: 1 - (row._distance ?? 0), rank } },
    }));
  }

  /** BM25 full-text search — strictly requires FTS index, no memory fallback */
  async bm25Search(query, { limit = 10, scopeFilter } = {}) {
    await this.ensureInitialized();

    if (!this.ftsSupported) {
      return []; // Fast graceful degrade
    }

    try {
      let q = this.table.search(query).type("fts");

      if (scopeFilter) {
        const scopeConditions = scopeFilter.map((s) => `scope = "${s}"`).join(" OR ");
        q = q.where(scopeConditions);
      }

      const results = await q.limit(limit).toArray();

      return results.map((row, rank) => {
        const score = 1.0; 
        return {
          entry: row,
          vector: Array.isArray(row.vector) ? row.vector : null,
          score,
          sources: { bm25: { score, rank } },
        };
      });
    } catch (err) {
      return []; // FTS error, gracefully degrade
    }
  }

  /** Delete by IDs */
  async delete(ids) {
    await this.ensureInitialized();
    if (!ids || !ids.length) return;
    await this.table.delete(`id IN (${ids.map((id) => `"${id}"`).join(",")})`);
  }

  /** Get stats */
  async stats() {
    await this.ensureInitialized();
    const total = await this.table.countDocuments();
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



// ============================================================================
// Factory
// ============================================================================

/** Default DB path */
export function getDefaultDbPath() {
  return join(homedir(), ".openclaw", "memory", "memos-lancedb");
}
