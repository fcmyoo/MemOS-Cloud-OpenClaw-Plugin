/**
 * Embedding Abstraction Layer for MemOS Plugin
 * OpenAI-compatible API for various embedding providers.
 * Includes LRU cache with TTL.
 */

import { createHash } from "node:crypto";

// ============================================================================
// Known model dimensions
// ============================================================================

const MODEL_DIMENSIONS = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "BAAI/bge-m3": 1024,
  "jina-embeddings-v5-small": 1024,
  "jina-embeddings-v5-base": 768,
  "ai/qwen3-embedding": 1024,
  "ai/qwen3-embedding:4B": 1024,
};

// ============================================================================
// LRU Cache with TTL
// ============================================================================

class EmbeddingCache {
  constructor(maxSize = 256, ttlMinutes = 30) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
    this.hits = 0;
    this.misses = 0;
  }

  _key(text, task) {
    const raw = `${task || ""}:${text}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 24);
  }

  get(text, task) {
    const k = this._key(text, task);
    const entry = this.cache.get(k);
    if (!entry) { this.misses++; return undefined; }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(k);
      this.misses++;
      return undefined;
    }
    // Move to end (MRU)
    this.cache.delete(k);
    this.cache.set(k, entry);
    this.hits++;
    return entry.vector;
  }

  set(text, task, vector) {
    const k = this._key(text, task);
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(k, { vector, createdAt: Date.now() });
  }

  get stats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "N/A",
    };
  }
}

// ============================================================================
// Embedder
// ============================================================================

export class Embedder {
  /**
   * @param {{
   *   apiKey?: string|string[],
   *   model?: string,
   *   baseURL?: string,
   *   dimensions?: number,
   *   taskQuery?: string,
   *   normalized?: boolean,
   * }} config
   */
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model || "text-embedding-3-small";
    this.baseURL = (config.baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
    this.dimensions = config.dimensions || MODEL_DIMENSIONS[this.model] || 1024;
    this.taskQuery = config.taskQuery;
    this.normalized = config.normalized ?? false;
    this.cache = new EmbeddingCache(256, 30);

    // Build OpenAI-compatible client
    this._initClient();
  }

  _initClient() {
    // Dynamic import of openai to allow plugin to load without it installed
    // But we use native fetch for simplicity
    this._client = null; // Will use _embed directly
  }

  /**
   * Embed a single text.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    const cached = this.cache.get(text, this.taskQuery);
    if (cached) return cached;

    const vector = await this._embed(text);
    this.cache.set(text, this.taskQuery, vector);
    return vector;
  }

  /**
   * Embed multiple texts in batch.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embedBatch(texts) {
    const results = [];
    const uncached = [];
    const uncachedIndices = [];

    // Check cache first
    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i], this.taskQuery);
      if (cached) {
        results[i] = cached;
      } else {
        results[i] = null;
        uncached.push(texts[i]);
        uncachedIndices.push(i);
      }
    }

    // Batch-embed uncached
    if (uncached.length > 0) {
      const vectors = await this._embedBatch(uncached);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        const vec = vectors[j];
        results[idx] = vec;
        this.cache.set(uncached[j], this.taskQuery, vec);
      }
    }

    return results;
  }

  /** Low-level embed via fetch */
  async _embed(text) {
    const body = {
      model: this.model,
      input: text,
    };
    if (this.dimensions && this.model !== "text-embedding-3-small") {
      body.dimensions = this.dimensions;
    }
    if (this.normalized) body.normalize = true;
    if (this.taskQuery) body.task = this.taskQuery;

    const res = await this._post("/embeddings", body);
    return res.data[0].embedding;
  }

  async _embedBatch(texts) {
    const body = {
      model: this.model,
      input: texts,
    };
    if (this.dimensions && this.model !== "text-embedding-3-small") {
      body.dimensions = this.dimensions;
    }
    if (this.normalized) body.normalize = true;
    if (this.taskQuery) body.task = this.taskQuery;

    const res = await this._post("/embeddings", body);
    return res.data.map((d) => d.embedding);
  }

  async _post(path, body) {
    const apiKey = Array.isArray(this.apiKey)
      ? this.apiKey[Math.floor(Math.random() * this.apiKey.length)]
      : this.apiKey;

    const res = await fetch(`${this.baseURL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Embedding API error ${res.status}: ${err}`);
    }

    return res.json();
  }

  get cacheStats() {
    return this.cache.stats;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an embedder from plugin config.
 * @param {Record<string,any>} config - from plugin config.lancedb.embedding
 */
export function createEmbedder(config) {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || process.env.LANCEDB_EMBED_API_KEY;
  return new Embedder({
    apiKey,
    model: config.model || "text-embedding-3-small",
    baseURL: config.baseURL,
    dimensions: config.dimensions,
    taskQuery: config.taskQuery,
    normalized: config.normalized,
  });
}
