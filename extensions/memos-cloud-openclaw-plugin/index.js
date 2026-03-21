#!/usr/bin/env node
/**
 * MemOS Cloud OpenClaw Plugin
 * With LanceDB Hybrid Retrieval Enhancement
 *
 * Lifecycle hooks:
 *   before_agent_start  → LanceDB hybrid recall + MemOS recall (merged)
 *   agent_end           → Write to MemOS (unchanged)
 */

import {
  addMessage,
  buildConfig,
  extractText,
  formatPromptBlock,
  USER_QUERY_MARKER,
  searchMemory,
} from "./lib/memos-cloud-api.js";

// ── LanceDB Integration ───────────────────────────────────────────────────────
import { createEmbedder } from "./lib/lancedb-embedder.js";
import { createRetriever } from "./lib/lancedb-retriever.js";
import { mergeAndFormat, formatLanceDBOnly } from "./lib/lancedb-fusion.js";

// ── State ────────────────────────────────────────────────────────────────────
let lastCaptureTime = 0;
const conversationCounters = new Map();
const recallCache = new Map();

// LanceDB instances (initialized lazily)
let lancedbRetriever = null;
let lancedbInitialized = false;

/** Environment variable hints */
const API_KEY_HELP_URL = "https://memos-dashboard.openmem.net/cn/apikeys/";
const ENV_FILE_SEARCH_HINTS = ["~/.openclaw/.env", "~/.moltbot/.env", "~/.clawdbot/.env"];
const MEMOS_SOURCE = "openclaw";

// ── LanceDB Initialization ────────────────────────────────────────────────────

/**
 * Lazily initialize LanceDB retriever from plugin config.
 * Returns true if LanceDB is enabled and initialized.
 *
 * Auto-enables when:
 * - lancedb.enabled is not explicitly false, AND
 * - An embedder API key is available (from config, or env var)
 */
function initLanceDB(cfg) {
  if (lancedbInitialized) return lancedbRetriever !== null;
  lancedbInitialized = true;

  const lancedbConfig = cfg.lancedb;

  // Guard: if lancedb config is not provided at all, skip silently
  if (!lancedbConfig) {
    return false;
  }

  const isExplicitlyDisabled = lancedbConfig.enabled === false;

  if (isExplicitlyDisabled) {
    return false;
  }

  // Auto-enable: if embedder API key is available, turn on LanceDB
  const hasEmbedderKey = Boolean(
    lancedbConfig.embedder?.apiKey ||
    process.env.OPENAI_API_KEY ||
    process.env.LANCEDB_EMBED_API_KEY
  );

  if (!hasEmbedderKey) {
    return false;
  }

  try {
    const embedder = createEmbedder({
      apiKey: lancedbConfig.embedder?.apiKey
        || process.env.LANCEDB_EMBED_API_KEY
        || process.env.OPENAI_API_KEY,
      model: lancedbConfig.embedder?.model || "BAAI/bge-m3",
      baseURL: lancedbConfig.embedder?.baseURL
        || process.env.LANCEDB_EMBED_BASE_URL
        || "https://api.siliconflow.cn/v1",
      dimensions: lancedbConfig.embedder?.dimensions || 1024,
      taskQuery: lancedbConfig.embedder?.taskQuery,
      normalized: lancedbConfig.embedder?.normalized ?? true,
    });

    lancedbRetriever = createRetriever(
      {
        ...lancedbConfig,
        rerankApiKey: lancedbConfig.rerankApiKey
          || process.env.JINA_RERANK_API_KEY
          || process.env.LANCEDB_RERANK_API_KEY,
      },
      embedder,
    );
    return true;
  } catch (err) {
    console.warn(`[memos-cloud] LanceDB init failed: ${err.message}`);
    return false;
  }
}

// ── MemOS Core Utilities ─────────────────────────────────────────────────────

function warnMissingApiKey(log, context) {
  const heading = "[memos-cloud] Missing MEMOS_API_KEY (Token auth)";
  const header = `${heading}${context ? `; ${context} skipped` : ""}. Configure it with:`;
  log.warn?.(
    [
      header,
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.zshrc",
      "source ~/.zshrc",
      "or",
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.bashrc",
      "source ~/.bashrc",
      `Get API key: ${API_KEY_HELP_URL}`,
    ].join("\n"),
  );
}

function stripPrependedPrompt(content) {
  if (!content) return content;
  const idx = content.lastIndexOf(USER_QUERY_MARKER);
  if (idx === -1) return content;
  return content.slice(idx + USER_QUERY_MARKER.length).trimStart();
}

function getCounterSuffix(sessionKey) {
  if (!sessionKey) return "";
  const current = conversationCounters.get(sessionKey) ?? 0;
  return current > 0 ? `#${current}` : "";
}

function bumpConversationCounter(sessionKey) {
  if (!sessionKey) return;
  const current = conversationCounters.get(sessionKey) ?? 0;
  conversationCounters.set(sessionKey, current + 1);
}

function resolveConversationId(cfg, ctx) {
  if (cfg.conversationId) return cfg.conversationId;
  const base = ctx?.sessionKey || ctx?.sessionId || (ctx?.agentId ? `openclaw:${ctx.agentId}` : "");
  const dynamicSuffix = cfg.conversationSuffixMode === "counter" ? getCounterSuffix(ctx?.sessionKey) : "";
  const prefix = cfg.conversationIdPrefix || "";
  const suffix = cfg.conversationIdSuffix || "";
  if (base) return `${prefix}${base}${dynamicSuffix}${suffix}`;
  return `${prefix}openclaw-${Date.now()}${dynamicSuffix}${suffix}`;
}

function makeTraceId() {
  return `memos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function logEvent(log, level, event, fields = {}) {
  const entry = { event, ts: new Date().toISOString(), ...fields };
  const line = `[memos-cloud] ${JSON.stringify(entry)}`;
  if (level === "warn") { log.warn?.(line); return; }
  log.info?.(line);
}

function buildIdentity(cfg, ctx) {
  const userId = cfg.userId || "openclaw-user";
  const chatId = ctx?.sessionKey || ctx?.sessionId || "default-chat";
  const threadId = ctx?.threadId || "";
  return {
    tenantId: cfg.tenantId || "default",
    channel: cfg.channel || "openclaw",
    chatId,
    userId,
    threadId,
  };
}

function resolveScopeKey(cfg, ctx) {
  const id = buildIdentity(cfg, ctx);
  if (cfg.memoryScopeMode === "user") return `${id.tenantId}:${id.channel}:user:${id.userId}`;
  if (cfg.memoryScopeMode === "chat") return `${id.tenantId}:${id.channel}:chat:${id.chatId}`;
  return `${id.tenantId}:${id.channel}:chat:${id.chatId}:user:${id.userId}`;
}

function resolveSessionId(cfg, ctx) {
  const conversationId = resolveConversationId(cfg, ctx);
  if (conversationId) return conversationId;
  return resolveScopeKey(cfg, ctx);
}

function hashStringToBucket(input) {
  let hash = 0;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % 100;
}

function isMemoryEnabledForContext(cfg, ctx) {
  if (!cfg.memoryEnabled) return false;
  const percent = Number.isFinite(cfg.memoryGrayPercent) ? cfg.memoryGrayPercent : 100;
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const scopeKey = resolveScopeKey(cfg, ctx);
  return hashStringToBucket(scopeKey) < percent;
}

function readRecallCache(key) {
  const cached = recallCache.get(key);
  if (!cached) return null;
  if (cached.expireAt <= Date.now()) {
    recallCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeRecallCache(key, value, ttlSec) {
  if (!ttlSec || ttlSec <= 0) return;
  recallCache.set(key, {
    value,
    expireAt: Date.now() + ttlSec * 1000,
  });
}

function buildSearchPayload(cfg, prompt, ctx) {
  const queryRaw = `${cfg.queryPrefix || ""}${prompt}`;
  const query =
    Number.isFinite(cfg.maxQueryChars) && cfg.maxQueryChars > 0
      ? queryRaw.slice(0, cfg.maxQueryChars)
      : queryRaw;
  const scopeKey = resolveScopeKey(cfg, ctx);

  const payload = {
    user_id: cfg.userId,
    query,
    source: MEMOS_SOURCE,
    session_id: resolveSessionId(cfg, ctx),
  };

  if (!cfg.recallGlobal) payload.session_id = resolveSessionId(cfg, ctx);
  if (cfg.filter) payload.filter = cfg.filter;
  if (cfg.knowledgebaseIds?.length) payload.readable_cube_ids = cfg.knowledgebaseIds;

  payload.top_k = cfg.memoryTopK;
  payload.include_preference = cfg.includePreference;
  payload.pref_top_k = cfg.preferenceLimitNumber;
  payload.search_tool_memory = cfg.includeToolMemory;
  payload.tool_mem_top_k = cfg.toolMemoryLimitNumber;
  payload.relativity = cfg.relativity;

  return payload;
}

function buildAddMessagePayload(cfg, messages, ctx) {
  const asyncMode = cfg.memoryWriteAsync ? "async" : "sync";
  const identity = buildIdentity(cfg, ctx);
  const payload = {
    user_id: cfg.userId,
    session_id: resolveSessionId(cfg, ctx),
    messages,
    source: MEMOS_SOURCE,
    async_mode: asyncMode,
  };

  if (cfg.tags?.length) payload.custom_tags = cfg.tags;
  if (cfg.allowKnowledgebaseIds?.length) payload.writable_cube_ids = cfg.allowKnowledgebaseIds;

  const info = {
    source: "openclaw",
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    tenant_id: identity.tenantId,
    channel: identity.channel,
    chat_id: identity.chatId,
    user_id: identity.userId,
    thread_id: identity.threadId || undefined,
    scope_mode: cfg.memoryScopeMode,
    scope_key: resolveScopeKey(cfg, ctx),
    ...(cfg.info || {}),
  };
  if (cfg.agentId) info.agent_id = cfg.agentId;
  if (cfg.appId) info.app_id = cfg.appId;
  if (Object.keys(info).length > 0) payload.info = info;

  return payload;
}

function pickLastTurnMessages(messages, cfg) {
  const lastUserIndex = messages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m?.role === "user")
    .map(({ idx }) => idx)
    .pop();

  if (lastUserIndex === undefined) return [];

  const slice = messages.slice(lastUserIndex);
  const results = [];

  for (const msg of slice) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
      continue;
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }

  return results;
}

function pickFullSessionMessages(messages, cfg) {
  const results = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }
  return results;
}

function truncate(text, maxLen) {
  if (!text) return "";
  if (!maxLen) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

// ── Main Plugin ───────────────────────────────────────────────────────────────

export default {
  id: "memos-cloud-openclaw-plugin",
  name: "MemOS Cloud OpenClaw Plugin",
  description: "MemOS Cloud with LanceDB hybrid retrieval (vector+BM25+rerank precision layer)",
  kind: "lifecycle",

  register(api) {
    const cfg = buildConfig(api.pluginConfig);
    const log = api.logger ?? console;

    if (!cfg.envFileStatus?.found) {
      const searchPaths = cfg.envFileStatus?.searchPaths?.join(", ") ?? ENV_FILE_SEARCH_HINTS.join(", ");
      log.warn?.(`[memos-cloud] No .env found in ${searchPaths}; falling back to process env or plugin config.`);
    }

    // ── Conversation counter for /new hook ────────────────────────────────
    if (cfg.conversationSuffixMode === "counter" && cfg.resetOnNew) {
      if (api.config?.hooks?.internal?.enabled !== true) {
        log.warn?.("[memos-cloud] command:new hook requires hooks.internal.enabled = true");
      }
      api.registerHook(
        ["command:new"],
        (event) => {
          if (event?.type === "command" && event?.action === "new") {
            bumpConversationCounter(event.sessionKey);
          }
        },
        {
          name: "memos-cloud-conversation-new",
          description: "Increment MemOS conversation suffix on /new",
        },
      );
    }

    // ── Lazy init LanceDB ─────────────────────────────────────────────────
    const lancedbEnabled = initLanceDB(cfg);

    if (lancedbEnabled) {
      log.info?.("[memos-cloud] LanceDB hybrid retrieval enabled");
    }

    // ── before_agent_start: LanceDB → MemOS merged recall ─────────────────
    api.on("before_agent_start", async (event, ctx) => {
      if (!cfg.recallEnabled) return;
      if (!isMemoryEnabledForContext(cfg, ctx)) {
        logEvent(log, "info", "recall.gray_skip", {
          scope_key: resolveScopeKey(cfg, ctx),
          memory_gray_percent: cfg.memoryGrayPercent,
        });
        return;
      }
      if (!event?.prompt || event.prompt.length < 3) return;

      const traceId = makeTraceId();
      const startedAt = Date.now();

      try {
        const prompt = event.prompt;

        // ── Step 1: LanceDB hybrid recall (precision layer) ─────────────
        let lancedbResults = [];
        let lancedbTrace = null;

        if (lancedbEnabled && lancedbRetriever) {
          try {
            const lancedbStart = Date.now();
            const ldbOutput = await lancedbRetriever.retrieve(prompt, {
              scopeFilter: [resolveScopeKey(cfg, ctx), "global"],
            });
            lancedbResults = ldbOutput.results || [];
            lancedbTrace = ldbOutput.trace;
            logEvent(log, "info", "lancedb.recall", {
              trace_id: traceId,
              count: lancedbResults.length,
              elapsed_ms: Date.now() - lancedbStart,
            });
          } catch (err) {
            log.warn?.(`[memos-cloud] LanceDB recall error (falling back to MemOS only): ${err.message}`);
            lancedbResults = [];
          }
        }

        // ── Step 2: MemOS native recall ─────────────────────────────────
        let memosData = null;
        let memosSuccess = false;

        if (cfg.apiKey) {
          try {
            const payload = buildSearchPayload(cfg, prompt, ctx);
            const memosResult = await searchMemory(
              { ...cfg, timeoutMs: cfg.memorySearchTimeoutMs, retries: 0 },
              payload,
            );
            memosData = memosResult;
            memosSuccess = true;

            logEvent(log, "info", "memos.recall", {
              trace_id: traceId,
              elapsed_ms: Date.now() - startedAt,
              lancedb_count: lancedbResults.length,
            });
          } catch (err) {
            log.warn?.(`[memos-cloud] MemOS recall error: ${err.message}`);
          }
        } else {
          warnMissingApiKey(log, "recall");
        }

        // ── Step 3: Merge and inject ────────────────────────────────────
        let prependContext = "";

        if (lancedbResults.length > 0 && memosData) {
          // Both available → merge
          prependContext = mergeAndFormat(lancedbResults, memosData?.data, {
            topK: cfg.memoryTopK,
            lancedbPriority: 3,
          });
        } else if (lancedbResults.length > 0) {
          // LanceDB only → format as precision block
          prependContext = formatLanceDBOnly(lancedbResults, { topK: 4 });
        } else if (memosSuccess && memosData) {
          // MemOS only → use native formatter
          prependContext = formatPromptBlock(memosData, {
            wrapTagBlocks: true,
            relativity: cfg.relativity,
            maxOutputChars: cfg.memoryBudgetTokens * 4,
          }) || "";
        }

        if (!prependContext) return;

        logEvent(log, "info", "recall.success", {
          trace_id: traceId,
          cost_ms: Date.now() - startedAt,
          lancedb_count: lancedbResults.length,
          memos_success: memosSuccess,
          total_chars: prependContext.length,
        });

        return { prependContext };
      } catch (err) {
        logEvent(log, "warn", "recall.failed", {
          trace_id: traceId,
          cost_ms: Date.now() - startedAt,
          degrade: cfg.memoryDegradeOnError,
          error: String(err),
        });
        if (!cfg.memoryDegradeOnError) throw err;
      }
    });

    // ── agent_end: write to MemOS (unchanged) ──────────────────────────────
    api.on("agent_end", async (event, ctx) => {
      if (!cfg.addEnabled) return;
      if (!isMemoryEnabledForContext(cfg, ctx)) return;
      if (!event?.success || !event?.messages?.length) return;
      if (!cfg.apiKey) {
        warnMissingApiKey(log, "add");
        return;
      }
      const traceId = makeTraceId();
      const startedAt = Date.now();

      const now = Date.now();
      if (cfg.throttleMs && now - lastCaptureTime < cfg.throttleMs) {
        return;
      }
      lastCaptureTime = now;

      try {
        const messages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        if (!messages.length) return;

        const payload = buildAddMessagePayload(cfg, messages, ctx);
        await addMessage(
          { ...cfg, retries: cfg.memoryWriteRetry },
          payload,
        );
        logEvent(log, "info", "add.success", {
          trace_id: traceId,
          cost_ms: Date.now() - startedAt,
          scope_key: payload.session_id,
          async_mode: payload.async_mode,
          message_count: messages.length,
        });
      } catch (err) {
        logEvent(log, "warn", "add.failed", {
          trace_id: traceId,
          cost_ms: Date.now() - startedAt,
          degrade: cfg.memoryDegradeOnError,
          error: String(err),
        });
        if (!cfg.memoryDegradeOnError) throw err;
      }
    });
  },
};
