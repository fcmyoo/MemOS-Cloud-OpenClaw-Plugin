/**
 * LanceDB Hybrid Retrieval Engine
 * Vector + BM25 → RRF Fusion → Cross-Encoder Rerank → MMR Diversity
 *
 * This is the core precision layer that overrides MemOS native recall
 * for the most accurate memory retrieval.
 */

import { MemoryStore, cosineSimilarity } from "./lancedb-client.js";

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG = {
  enabled: false,  // Opt-in via config
  dbPath: null,
  vectorDim: 1024,

  // Hybrid weights
  vectorWeight: 0.7,
  bm25Weight: 0.3,

  // Retrieval limits
  candidatePoolSize: 20,
  topK: 6,
  minScore: 0.3,
  hardMinScore: 0.35,

  // Rerank
  rerank: "cross-encoder",  // "cross-encoder" | "lightweight" | "none"
  rerankApiKey: null,
  rerankModel: "jina-reranker-v3",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",

  // Adaptive retrieval
  filterNoise: true,
  skipShortQueries: true,
  minQueryLength: 5,  // Skip queries shorter than this

  // Scoring adjustments
  recencyWeight: 0.1,
  recencyHalfLifeDays: 14,
  lengthNormAnchor: 500,
  timeDecayHalfLifeDays: 60,

  // Embedding
  embedder: null,  // Embedder instance
};

// ============================================================================
// Retrieval Result
// ============================================================================

/**
 * @typedef {Object} LanceDBResult
 * @property {string} id
 * @property {string} text
 * @property {string} category
 * @property {string} scope
 * @property {number} importance
 * @property {number} timestamp
 * @property {number} score - final combined score
 * @property {{ vector?: number, bm25?: number, reranked?: number }} sources
 */

// ============================================================================
// Noise Patterns (from memory-lancedb-pro)
// ============================================================================

const SKIP_PATTERNS = [
  /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|greetings)\b/i,
  /^\//,
  /^(yes|no|yep|nope|ok|okay|sure|fine|thanks|thank you|cool|nice|great)\s*[.!]?$/i,
  /^(go ahead|continue|proceed|实施|開始|继续|好的|可以|行)\b/i,
  /^[\p{Emoji}\s]+$/u,
  /HEARTBEAT/i,
  /^\[System/i,
];

const FORCE_RETRIEVE_PATTERNS = [
  /\b(remember|recall|forgot|memory|memories)\b/i,
  /\b(last time|before|previously|earlier|yesterday|ago)\b/i,
  /\b(my (name|email|phone|address|birthday|preference))\b/i,
  /\b(what did i (say|mention|tell))\b/i,
  /(你记得|之前|上次|还记得|说过)/i,
];

// ============================================================================
// Retriever
// ============================================================================

export class LanceDBRetriever {
  constructor(config = {}) {
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    this.store = null;
    this._embedder = null;
    this._initialized = false;
  }

  setEmbedder(embedder) {
    this._embedder = embedder;
  }

  async ensureInitialized() {
    if (this._initialized) return;

    if (!this.config.enabled) {
      this._initialized = true;
      return;
    }

    const path = this.config.dbPath;
    if (!path) {
      this.config.enabled = false;
      this._initialized = true;
      return;
    }

    try {
      this.store = new MemoryStore({
        dbPath: path,
        vectorDim: this.config.vectorDim || 1024,
      });
      await this.store.ensureInitialized();
      this._initialized = true;
    } catch (err) {
      console.warn(`[memos-lancedb] Failed to init LanceDB store: ${err.message}`);
      this.config.enabled = false;
      this._initialized = true;
    }
  }

  /**
   * Should we skip retrieval for this query?
   */
  shouldSkipQuery(query) {
    const trimmed = query.trim();

    if (trimmed.length < this.config.minQueryLength) return true;
    if (SKIP_PATTERNS.some((p) => p.test(trimmed))) return true;
    if (FORCE_RETRIEVE_PATTERNS.some((p) => p.test(trimmed))) return false;

    return false;
  }

  /**
   * Main retrieval entry point.
   * @param {string} query
   * @param {{ limit?: number, scopeFilter?: string[] }} options
   * @returns {Promise<{ results: LanceDBResult[], trace: object }>}
   */
  async retrieve(query, options = {}) {
    const startedAt = Date.now();
    const trace = { query, stages: [], totalElapsedMs: 0 };

    await this.ensureInitialized();

    if (!this.config.enabled || !this.store || !this._embedder) {
      return { results: [], trace };
    }

    if (this.shouldSkipQuery(query)) {
      trace.stages.push({ name: "skipped", reason: "query_too_short_or_noise", elapsedMs: 0 });
      trace.totalElapsedMs = Date.now() - startedAt;
      return { results: [], trace };
    }

    const limit = options.limit || this.config.topK;
    const poolSize = this.config.candidatePoolSize;
    const scopeFilter = options.scopeFilter;

    try {
      // Step 1: Embed query
      const embedStart = Date.now();
      const queryVector = await this._embedder.embed(query);
      trace.stages.push({ name: "embed", elapsedMs: Date.now() - embedStart });

      // Step 2: Vector search
      const vectorStart = Date.now();
      const vectorResults = await this.store.vectorSearch(queryVector, {
        limit: poolSize,
        scopeFilter,
      });
      trace.stages.push({
        name: "vector_search",
        inputCount: poolSize,
        outputCount: vectorResults.length,
        elapsedMs: Date.now() - vectorStart,
      });

      // Step 3: BM25 search
      const bm25Start = Date.now();
      const bm25Results = await this.store.bm25Search(query, {
        limit: poolSize,
        scopeFilter,
      });
      trace.stages.push({
        name: "bm25_search",
        inputCount: poolSize,
        outputCount: bm25Results.length,
        elapsedMs: Date.now() - bm25Start,
      });

      // Step 4: RRF Fusion
      const fusionStart = Date.now();
      const fused = this._rrfFusion(vectorResults, bm25Results);
      trace.stages.push({
        name: "rrf_fusion",
        inputCount: vectorResults.length + bm25Results.length,
        outputCount: fused.length,
        elapsedMs: Date.now() - fusionStart,
      });

      // Step 5: Apply recency boost
      const recencyStart = Date.now();
      const recencyBoosted = this._applyRecencyBoost(fused);
      trace.stages.push({ name: "recency_boost", elapsedMs: Date.now() - recencyStart });

      // Step 6: Cross-encoder rerank (if enabled)
      let reranked = recencyBoosted;
      if (this.config.rerank === "cross-encoder" && this.config.rerankApiKey) {
        const rerankStart = Date.now();
        reranked = await this._crossEncoderRerank(query, recencyBoosted);
        trace.stages.push({
          name: "cross_encoder_rerank",
          inputCount: recencyBoosted.length,
          outputCount: reranked.length,
          elapsedMs: Date.now() - rerankStart,
        });
      }

      // Step 7: Length normalization
      const lengthStart = Date.now();
      const lengthNormed = this._applyLengthNormalization(reranked);
      trace.stages.push({ name: "length_norm", elapsedMs: Date.now() - lengthStart });

      // Step 8: Hard min score cutoff
      const filtered = lengthNormed.filter((r) => r.score >= this.config.hardMinScore);

      // Step 9: MMR diversity (greedy dedup by cosine similarity)
      const mmrStart = Date.now();
      const final = this._applyMMRDiversity(filtered, limit);
      trace.stages.push({
        name: "mmr_diversity",
        inputCount: filtered.length,
        outputCount: final.length,
        elapsedMs: Date.now() - mmrStart,
      });

      trace.totalElapsedMs = Date.now() - startedAt;
      return { results: final, trace };
    } catch (err) {
      trace.error = err.message;
      trace.totalElapsedMs = Date.now() - startedAt;
      console.error(`[memos-lancedb] Retrieval error: ${err.message}`);
      return { results: [], trace };
    }
  }

  // ── RRF Fusion ────────────────────────────────────────────────────────────

  _rrfFusion(vectorResults, bm25Results) {
    const k = 60; // RRF constant
    const scoreMap = new Map();

    // Vector scores
    vectorResults.forEach((r, idx) => {
      const rrf = 1 / (k + idx + 1);
      const score = this.config.vectorWeight * rrf;
      const existing = scoreMap.get(r.entry.id);
      if (existing) {
        existing.score += score;
        existing.sources.vector = r.score;
      } else {
        scoreMap.set(r.entry.id, {
          id: r.entry.id,
          text: r.entry.text,
          category: r.entry.category,
          scope: r.entry.scope,
          importance: r.entry.importance,
          timestamp: r.entry.timestamp,
          metadata: r.entry.metadata,
          score,
          sources: { vector: r.score },
        });
      }
    });

    // BM25 scores
    bm25Results.forEach((r, idx) => {
      const rrf = 1 / (k + idx + 1);
      const score = this.config.bm25Weight * rrf;
      const existing = scoreMap.get(r.entry.id);
      if (existing) {
        existing.score += score;
        existing.sources.bm25 = r.score;
      } else {
        scoreMap.set(r.entry.id, {
          id: r.entry.id,
          text: r.entry.text,
          category: r.entry.category,
          scope: r.entry.scope,
          importance: r.entry.importance,
          timestamp: r.entry.timestamp,
          metadata: r.entry.metadata,
          score,
          sources: { bm25: r.score },
        });
      }
    });

    return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
  }

  // ── Recency Boost ─────────────────────────────────────────────────────────

  _applyRecencyBoost(results) {
    const halfLifeMs = this.config.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
    const maxBoost = this.config.recencyWeight;
    const now = Date.now();

    return results.map((r) => {
      const ageMs = now - (r.timestamp || now);
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      // boost factor: 0 → maxBoost as age goes from 0 → halfLife
      const boost = maxBoost * Math.exp(-ageDays * Math.LN2 / this.config.recencyHalfLifeDays);
      return { ...r, score: r.score + boost };
    });
  }

  // ── Length Normalization ──────────────────────────────────────────────────

  _applyLengthNormalization(results) {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) return results;

    return results.map((r) => {
      const charLen = (r.text || "").length;
      if (charLen <= anchor) return r;
      const ratio = charLen / anchor;
      const logRatio = Math.log2(Math.max(ratio, 1));
      const factor = 1 / (1 + 0.5 * logRatio);
      return { ...r, score: r.score * factor };
    });
  }

  // ── MMR Diversity ────────────────────────────────────────────────────────

  _applyMMRDiversity(results, limit) {
    const threshold = 0.85;
    const selected = [];
    const deferred = [];

    for (const candidate of results) {
      const tooSimilar = selected.some((s) => {
        if (!s.vector || !candidate.vector) return false;
        if (!s.vector.length || !candidate.vector.length) return false;
        const sim = cosineSimilarity(s.vector, candidate.vector);
        return sim > threshold;
      });

      if (tooSimilar) {
        deferred.push(candidate);
      } else {
        selected.push(candidate);
      }
    }

    return [...selected, ...deferred].slice(0, limit);
  }

  // ── Cross-Encoder Rerank ─────────────────────────────────────────────────

  async _crossEncoderRerank(query, results) {
    if (!results.length || !this.config.rerankApiKey) return results;

    try {
      const documents = results.map((r) => r.text);

      const res = await fetch(`${this.config.rerankEndpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.rerankApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.rerankModel,
          query,
          documents,
          top_n: Math.min(results.length, this.config.topK * 2),
          return_documents: false,
        }),
      });

      if (!res.ok) {
        console.warn(`[memos-lancedb] Rerank API error: ${res.status}`);
        return results;
      }

      const data = await res.json();

      // Map rerank results back
      const reranked = (data.results || []).map((item, idx) => {
        const original = results[item.index];
        return {
          ...original,
          score: item.relevance_score,
          sources: { ...original.sources, reranked: item.relevance_score },
        };
      });

      return reranked.sort((a, b) => b.score - a.score);
    } catch (err) {
      console.warn(`[memos-lancedb] Rerank failed: ${err.message}`);
      return results;
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a retriever from plugin config.
 * @param {Record<string,any>} lancedbConfig - from plugin config.lancedb
 * @param {object} embedder - Embedder instance
 */
export function createRetriever(lancedbConfig, embedder = null) {
  const config = {
    enabled: lancedbConfig?.enabled ?? false,
    dbPath: lancedbConfig?.dbPath,
    vectorDim: lancedbConfig?.vectorDim || 1024,
    vectorWeight: lancedbConfig?.vectorWeight ?? 0.7,
    bm25Weight: lancedbConfig?.bm25Weight ?? 0.3,
    candidatePoolSize: lancedbConfig?.candidatePoolSize ?? 20,
    topK: lancedbConfig?.topK ?? 6,
    minScore: lancedbConfig?.minScore ?? 0.3,
    hardMinScore: lancedbConfig?.hardMinScore ?? 0.35,
    rerank: lancedbConfig?.rerank ?? "none",
    rerankApiKey: lancedbConfig?.rerankApiKey || process.env.JINA_RERANK_API_KEY || process.env.LANCEDB_RERANK_API_KEY,
    rerankModel: lancedbConfig?.rerankModel || "jina-reranker-v3",
    rerankEndpoint: lancedbConfig?.rerankEndpoint || "https://api.jina.ai/v1/rerank",
    filterNoise: lancedbConfig?.filterNoise ?? true,
    recencyWeight: lancedbConfig?.recencyWeight ?? 0.1,
    recencyHalfLifeDays: lancedbConfig?.recencyHalfLifeDays ?? 14,
    lengthNormAnchor: lancedbConfig?.lengthNormAnchor ?? 500,
    timeDecayHalfLifeDays: lancedbConfig?.timeDecayHalfLifeDays ?? 60,
  };

  const retriever = new LanceDBRetriever(config);
  if (embedder) retriever.setEmbedder(embedder);
  return retriever;
}
