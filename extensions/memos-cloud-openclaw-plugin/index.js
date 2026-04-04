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
import { getMemosFallbackDecision } from "./lib/memos-fallback.js";
import { normalizeMemosSearchResult } from "./lib/memos-result-normalizer.js";
import { buildUnifiedRecallResults, summarizeUnifiedRecall } from "./lib/unified-recall.js";

function buildRecallTrace({
  lancedbResults = [],
  lancedbTrace = null,
  fallbackDecision = null,
  memosNormalized = null,
  unifiedResults = [],
} = {}) {
  const lancedbTopScore = Number(lancedbResults[0]?.score ?? fallbackDecision?.topScore ?? 0);
  const fallbackReason = fallbackDecision?.reason || "not_needed";
  const memosSummary = memosNormalized?.summary || {
    textMem: 0,
    prefMem: 0,
    toolMem: 0,
    skillMem: 0,
    actMem: 0,
    paraMem: 0,
  };
  const unifiedPreview = summarizeUnifiedRecall(
    unifiedResults.length > 0 ? unifiedResults : buildUnifiedRecallResults(lancedbResults, memosNormalized),
    5,
  );

  return {
    lancedb: {
      count: lancedbResults.length,
      top_score: lancedbTopScore,
      trace: lancedbTrace,
    },
    fallback: {
      enabled: Boolean(fallbackDecision),
      reason: fallbackReason,
      lancedb_top_score: lancedbTopScore,
      should_fallback: Boolean(fallbackDecision?.shouldFallback),
    },
    memos: {
      summary: memosSummary,
    },
    unified: {
      count: unifiedResults.length > 0 ? unifiedResults.length : lancedbResults.length,
      preview: unifiedPreview,
    },
  };
}
function formatRecallResults(results) {
  if (!results || results.length === 0) return "";
  let out = "<recall>\\n";
  results.forEach(r => {
    const text = r.text || r.content || String(r);
    const cat = r.category || "memory";
    // avoid repetitive nested strings
    if (typeof text === "string" && text.trim()) {
      out += `[${cat}] ${text.trim()}\\n`;
    }
  });
  out += "</recall>";
  return out;
}

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
    const embedder = TEST_SEAMS.createEmbedder({
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

    lancedbRetriever = TEST_SEAMS.createRetriever(
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
  const heading = "[memos-cloud] Missing MEMOS_API_KEY (Authorization header)";
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

function cleanupRecallPrompt(prompt) {
  if (!prompt) return "";

  let text = String(prompt);
  const jsonBlockMatch = text.match(/```json[\s\S]*?```/gi);
  if (jsonBlockMatch?.length) {
    for (const block of jsonBlockMatch) {
      text = text.replace(block, " ");
    }
  }

  text = text
    .replace(/^[ \t]*Conversation info[\s\S]*?(?=\n\s*\n|\n[A-Z][^\n]{0,80}:|$)/gim, " ")
    .replace(/^[ \t]*Sender[\s\S]*?(?=\n\s*\n|\n[A-Z][^\n]{0,80}:|$)/gim, " ");

  text = stripPrependedPrompt(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\{[^}]{5,200}\}\s*$/gm, " ")
    .replace(/^\s*\[[^\]]{5,200}\]\s*$/gm, " ")
    .replace(/<precision-memories>[\s\S]*?<\/precision-memories>/gi, " ")
    .replace(/<system[\s\S]*?>/gi, " ")
    .replace(/\bConversation info\b[\s\S]{0,200}/g, " ")
    .replace(/\bSender\b[\s\S]{0,200}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return stripPrependedPrompt(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveRecallQuery(event, ctx) {
  if (event?.messages?.length) {
    const messages = event.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "user" || !message?.content) continue;

      const rawText = typeof message.content === "string"
        ? message.content
        : message.content?.text || extractText(message.content) || "";
      const text = stripPrependedPrompt(rawText).trim();
      if (text.length >= 5) return text;
    }
  }

  const prompt = cleanupRecallPrompt(event?.prompt || "");
  if (prompt) return prompt;

  return stripPrependedPrompt(event?.prompt || "").trim();
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

function resolveRuntimeAgentId(cfg, ctx) {
  if (ctx?.agentId) return String(ctx.agentId).trim();
  if (ctx?.sessionKey) return String(ctx.sessionKey).trim();
  if (cfg.agentId) return String(cfg.agentId).trim();
  return "default";
}

function buildRuntimeUserId(cfg, runtimeAgentId) {
  if (cfg.dynamicUserIdFormat === "agent:user") return `openclaw_${runtimeAgentId}:user`;
  return `openclaw_${runtimeAgentId}`;
}

function buildRuntimeConversationPrefix(cfg, runtimeAgentId) {
  if (cfg.dynamicConversationPrefixMode === "inherit") return cfg.conversationIdPrefix || "";
  return `${runtimeAgentId}:`;
}

function buildRuntimeTags(cfg, runtimeAgentId) {
  if (cfg.dynamicTagMode === "inherit") return Array.isArray(cfg.tags) ? cfg.tags : [];
  if (cfg.dynamicTagMode === "agent-only") return [runtimeAgentId];
  return [runtimeAgentId, "memos"];
}

/**
 * Infer a memory category from content keywords.
 * Used when writing to LanceDB so entries aren't all "other".
 */
function inferCategory(text) {
  if (!text) return "other";
  if (/(喜欢|偏好|不要|总是|习惯|prefer|always|never|like|dislike)/i.test(text)) return "preference";
  if (/(决定|结论|方案|选择|TODO|待办|决策|decided|conclusion|plan)/i.test(text)) return "decision";
  if (/(我是|我叫|我的名字|工作|公司|住在|I am|my name|I work)/i.test(text)) return "entity";
  if (/(记得|回忆|之前|上次|remember|recall|last time|previously)/i.test(text)) return "reflection";
  return "fact";
}

function isAgentAllowed(cfg, ctx) {
  if (!Array.isArray(cfg.allowedAgentIds) || cfg.allowedAgentIds.length === 0) return true;
  const runtimeAgentId = resolveRuntimeAgentId(cfg, ctx);
  return cfg.allowedAgentIds.includes(runtimeAgentId);
}

function resolveConversationId(cfg, ctx) {
  if (cfg.conversationId) return cfg.conversationId;
  const runtimeAgentId = resolveRuntimeAgentId(cfg, ctx);
  const base = ctx?.sessionKey || ctx?.sessionId || `openclaw:${runtimeAgentId}`;
  const dynamicSuffix = cfg.conversationSuffixMode === "counter" ? getCounterSuffix(ctx?.sessionKey) : "";
  const prefix = buildRuntimeConversationPrefix(cfg, runtimeAgentId);
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
  const runtimeAgentId = resolveRuntimeAgentId(cfg, ctx);
  const userId = buildRuntimeUserId(cfg, runtimeAgentId);
  const chatId = ctx?.sessionKey || ctx?.sessionId || "default-chat";
  const threadId = ctx?.threadId || "";
  return {
    tenantId: cfg.tenantId || "default",
    channel: cfg.channel || "openclaw",
    chatId,
    userId,
    threadId,
    agentId: runtimeAgentId,
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

function normalizeQuery(query) {
  const cleaned = cleanupRecallPrompt(query);
  if (!cleaned || cleaned.length < 2) return "";

  return String(cleaned)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

function buildRecallCacheKey(cfg, scopeKey, recallQuery, lancedbEnabled) {
  const sourceTag = lancedbEnabled ? (cfg.fallbackToCloud !== false ? "lm" : "l") : "m";
  return `${scopeKey}|${normalizeQuery(recallQuery)}|${sourceTag}`;
}

function shouldWriteMessage(msg, cfg) {
  if (!msg?.content) return false;
  const text = String(msg.content).trim();
  if (!text) return false;

  const assistantMinChars = 20;
  const userMinChars = 3;
  const minChars = msg.role === "assistant" ? assistantMinChars : userMinChars;
  if (text.length < minChars) return false;

  const fillerRe = /^(ok|okay|好的?|收到|明白|了解|嗯+|哦+|啊+|哈+|谢谢|thanks?|ty|yes|yep|yeah|sure|nice|cool|wow|perfect|great|我来看看|稍等|稍等一下|稍等哈)$/i;
  if (fillerRe.test(text)) return false;

  const strongKeepRe = /(记住|偏好|喜欢|不要|总是|以后|我的名字|我是|我叫|结论|决定|TODO|待办|风险|原因|修复|方案)/i;
  if (strongKeepRe.test(text)) return true;

  if (msg.role === "assistant" && text.length < 30) return false;
  return true;
}

function buildSearchPayload(cfg, prompt, ctx) {
  const queryRaw = `${cfg.queryPrefix || ""}${prompt}`;
  const query =
    Number.isFinite(cfg.maxQueryChars) && cfg.maxQueryChars > 0
      ? queryRaw.slice(0, cfg.maxQueryChars)
      : queryRaw;
  const scopeKey = resolveScopeKey(cfg, ctx);
  const identity = buildIdentity(cfg, ctx);

  const payload = {
    user_id: identity.userId,
    query,
    source: MEMOS_SOURCE,
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

function extractUserMessages(messages) {
  if (!messages || !Array.isArray(messages)) return "";
  return messages
    .filter((message) => message?.role === "user")
    .map((message) => {
      const content = message.content;
      return typeof content === "string" ? content : content?.text || "";
    })
    .filter((text) => text.trim().length > 0)
    .join(" ");
}

function buildAddMessagePayload(cfg, messages, ctx) {
  const asyncMode = cfg.memoryWriteAsync ? "async" : "sync";
  const identity = buildIdentity(cfg, ctx);
  const runtimeTags = buildRuntimeTags(cfg, identity.agentId);
  const payload = {
    user_id: identity.userId,
    session_id: resolveSessionId(cfg, ctx),
    messages,
    source: MEMOS_SOURCE,
    async_mode: asyncMode,
  };

  if (runtimeTags.length) payload.custom_tags = runtimeTags;
  if (cfg.allowKnowledgebaseIds?.length) payload.writable_cube_ids = cfg.allowKnowledgebaseIds;

  const info = {
    source: cfg.platform || "openclaw",
    platform: cfg.platform || "openclaw",
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
  info.agent_id = identity.agentId;
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

// ── Test Seams ───────────────────────────────────────────────────────────────

const TEST_SEAMS = {
  createEmbedder,
  createRetriever,
  searchMemory,
};

export function __setTestSeamsForTests(overrides = {}) {
  Object.assign(TEST_SEAMS, overrides);
}

export function __resetTestSeamsForTests() {
  TEST_SEAMS.createEmbedder = createEmbedder;
  TEST_SEAMS.createRetriever = createRetriever;
  TEST_SEAMS.searchMemory = searchMemory;
  lancedbRetriever = null;
  lancedbInitialized = false;
  lastCaptureTime = 0;
  conversationCounters.clear();
  recallCache.clear();
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
      log.info?.(`[memos-cloud] before_agent_start fired for channel: ${ctx?.channel || cfg.channel || "unknown"}, agentId: ${ctx?.agentId || "?"}`);
      if (!cfg.recallEnabled) return;
      if (!isAgentAllowed(cfg, ctx)) {
        logEvent(log, "info", "recall.agent_skip", {
          agent_id: resolveRuntimeAgentId(cfg, ctx),
        });
        return;
      }
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
        const recallQuery = resolveRecallQuery(event, ctx) || prompt;
        const scopeKey = resolveScopeKey(cfg, ctx);
        const recallCacheKey = buildRecallCacheKey(cfg, scopeKey, recallQuery, lancedbEnabled);
        const cachedResult = readRecallCache(recallCacheKey);

        if (cachedResult?.prependContext) {
          logEvent(log, "info", "recall.cache_hit", {
            trace_id: traceId,
            cost_ms: Date.now() - startedAt,
            total_chars: cachedResult.total_chars ?? 0,
            cache_key: recallCacheKey,
          });
          return {
            prependContext: cachedResult.prependContext,
            total_chars: cachedResult.total_chars ?? 0,
            unifiedResults: cachedResult.unifiedResults ?? [],
            trace: cachedResult.trace ?? {},
          };
        }

        // ── Step 1: LanceDB Principal Engine ─────────────
        let lancedbResults = [];
        let lancedbTrace = null;

        if (lancedbEnabled && lancedbRetriever) {
          try {
            const ldbOutput = await lancedbRetriever.retrieve(recallQuery, {
              scopeFilter: [resolveScopeKey(cfg, ctx), "global"],
            });
            lancedbResults = ldbOutput.results || [];
            lancedbTrace = ldbOutput.trace || null;
            logEvent(log, "info", "lancedb.recall", {
              trace_id: traceId,
              count: lancedbResults.length,
              top_score: lancedbResults[0]?.score || 0,
            });
          } catch (err) {
            log.warn?.(`[memos-cloud] LanceDB recall error: ${err.message}`);
          }
        }

        // Circuit Breaker: If we have strong local results, return immediately!
        const fallbackDecision = getMemosFallbackDecision(cfg, lancedbResults);
        const shouldRecallMemos = cfg.apiKey && (!lancedbEnabled || !lancedbRetriever || fallbackDecision.shouldFallback);

        let memosData = null;
        let memosNormalized = null;
        let unifiedResults = buildUnifiedRecallResults(lancedbResults, null);
        let memosSuccess = false;

        // ── Step 2: MemOS Cloud Fallback (if allowed and needed) ─────
        if (shouldRecallMemos) {
          try {
            const payload = buildSearchPayload(cfg, prompt, ctx);
            const memosResult = await TEST_SEAMS.searchMemory(
              { ...cfg, timeoutMs: cfg.memorySearchTimeoutMs, retries: 0 },
              payload,
            );

            memosData = memosResult;
            memosNormalized = normalizeMemosSearchResult(memosResult);
            unifiedResults = buildUnifiedRecallResults(lancedbResults, memosNormalized);
            memosSuccess = true;
            logEvent(log, "info", "memos.recall", {
              trace_id: traceId,
              elapsed_ms: Date.now() - startedAt,
              lancedb_count: lancedbResults.length,
              fallback_mode: cfg.memosSearchFallbackMode,
              fallback_enabled: cfg.memosSearchFallbackEnabled,
              recall: buildRecallTrace({
                lancedbResults,
                lancedbTrace,
                fallbackDecision,
                memosNormalized,
                unifiedResults,
              }),
            });
          } catch (err) {
            log.warn?.(`[memos-cloud] MemOS recall error: ${err.message}`);
          }
        } else if (!cfg.apiKey && (!lancedbEnabled || !lancedbRetriever)) {
          warnMissingApiKey(log, "recall");
        }

        const recallTrace = buildRecallTrace({
          lancedbResults,
          lancedbTrace,
          fallbackDecision,
          memosNormalized,
          unifiedResults,
        });

        let prependContext = "";

        if (lancedbResults.length > 0 && memosData) {
          prependContext = mergeAndFormat(lancedbResults, memosData?.data?.data || memosData?.data, {
            topK: cfg.memoryTopK,
            lancedbPriority: 3,
            normalizedMemos: memosNormalized,
            unifiedResults,
          });
        } else if (lancedbResults.length > 0) {
          prependContext = formatLanceDBOnly(lancedbResults, { topK: 4 });
        } else if (memosSuccess && memosData) {
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
          recall: recallTrace,
          total_chars: prependContext.length,
        });

        writeRecallCache(recallCacheKey, {
          prependContext,
          total_chars: prependContext.length,
          unifiedResults,
          trace: recallTrace,
        }, cfg.memoryCacheTtlSec);
        return {
          prependContext,
          total_chars: prependContext.length,
          unifiedResults,
          trace: recallTrace,
        };
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

    // ── agent_end: fallback recall + write to MemOS ────────────────────────
    api.on("agent_end", async (event, ctx) => {
      log.info?.(`[memos-cloud] agent_end fired for channel: ${ctx?.channel || cfg.channel || "unknown"}`);

      if (!cfg.addEnabled) return;
      if (!isAgentAllowed(cfg, ctx)) {
        const runtimeAgentId = resolveRuntimeAgentId(cfg, ctx);
        const hasAllowlist = Array.isArray(cfg.allowedAgentIds) && cfg.allowedAgentIds.length > 0;
        logEvent(log, "info", hasAllowlist ? "add.agent_skip_not_allowed" : "add.agent_skip_missing_allowlist", {
          agent_id: runtimeAgentId,
          allowed_agent_ids: hasAllowlist ? cfg.allowedAgentIds : [],
        });
        return;
      }
      if (!isMemoryEnabledForContext(cfg, ctx)) return;
      if (!event?.success || !event?.messages?.length) return;
      if (!cfg.apiKey) {
        warnMissingApiKey(log, "add");
        return;
      }
      const traceId = makeTraceId();
      const startedAt = Date.now();

      const now = Date.now();
      // Fix: throttleMs=0 means no throttle; only apply when explicitly > 0
      const effectiveThrottleMs = cfg.throttleMs != null && cfg.throttleMs >= 0
        ? cfg.throttleMs
        : 5000;
      if (effectiveThrottleMs > 0 && now - lastCaptureTime < effectiveThrottleMs) {
        logEvent(log, "info", "add.throttle_skip", {
          trace_id: traceId,
          throttle_ms: effectiveThrottleMs,
        });
        return;
      }
      lastCaptureTime = now;

      try {
        const rawMessages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        const messages = rawMessages.filter((msg) => shouldWriteMessage(msg, cfg));
        if (!messages.length) {
          logEvent(log, "info", "add.quality_skip", {
            trace_id: traceId,
            original_count: rawMessages.length,
            filtered_count: rawMessages.length,
          });
          return;
        }

        const scopeKey = resolveScopeKey(cfg, ctx);
        const lancedbText = extractUserMessages(messages) || messages.map(m => m.content).join(" ");
        
        // Push to local LanceDB (Synchronous execution)
        if (lancedbEnabled && lancedbRetriever?.store && lancedbRetriever?._embedder && lancedbText) {
           try {
              const category = inferCategory(lancedbText);
              const vector = await lancedbRetriever._embedder.embed(lancedbText);
              await lancedbRetriever.store.add({
                text: lancedbText,
                vector,
                timestamp: Date.now(),
                scope: scopeKey,
                category,
                importance: 0.5,
                metadata: JSON.stringify({
                  source: cfg.platform || "openclaw",
                  session_id: resolveSessionId(cfg, ctx),
                  agent_id: resolveRuntimeAgentId(cfg, ctx),
                }),
              });
              log.info?.(`[memos-cloud] LanceDB local write success (sync)`);
           } catch (err) {
              log.warn?.(`[memos-cloud] LanceDB local write failed: ${err.message}`);
           }
        }

        // Push to Cloud MemOS (Asynchronous backup)
        if (cfg.syncToCloud !== false) {
           void (async () => {
             try {
                const payload = buildAddMessagePayload(cfg, messages, ctx);
                await addMessage({ ...cfg, retries: cfg.memoryWriteRetry }, payload);
                logEvent(log, "info", "add.cloud_sync.success", { trace_id: traceId });
             } catch (err) {
                log.warn?.(`[memos-cloud] MemOS Cloud sync failed (async backup): ${err.message}`);
             }
           })();
        }
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
