#!/usr/bin/env node
import {
  addMessage,
  buildConfig,
  extractText,
  formatPromptBlock,
  USER_QUERY_MARKER,
  searchMemory,
} from "./lib/memos-cloud-api.js";
const captureTimes = new Map();
const conversationCounters = new Map();
const recallCache = new Map();
const API_KEY_HELP_URL = "https://memos-dashboard.openmem.net/cn/apikeys/";
const ENV_FILE_SEARCH_HINTS = ["~/.openclaw/.env", "~/.moltbot/.env", "~/.clawdbot/.env"];
const MEMOS_SOURCE = "openclaw";

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
      "or",
      "[System.Environment]::SetEnvironmentVariable(\"MEMOS_API_KEY\", \"mpg-...\", \"User\")",
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
  // TODO: consider binding conversation_id directly to OpenClaw sessionId (prefer ctx.sessionId).
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
  if (level === "warn") {
    log.warn?.(line);
    return;
  }
  log.info?.(line);
}

function buildIdentity(cfg, ctx) {
  const userId = resolveUserId(cfg, ctx);
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

function normalizeAgentId(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveUserId(cfg, ctx) {
  if (cfg.hasConfiguredUserId) return cfg.userId;
  const runtimeAgentId = normalizeAgentId(ctx?.agentId);
  if (runtimeAgentId) return `openclaw_${runtimeAgentId}`;
  return cfg.userId || "openclaw-user";
}

function resolveScopeKey(cfg, ctx) {
  const id = buildIdentity(cfg, ctx);
  if (cfg.memoryScopeMode === "user") return `${id.tenantId}:${id.channel}:user:${id.userId}`;
  if (cfg.memoryScopeMode === "chat") return `${id.tenantId}:${id.channel}:chat:${id.chatId}`;
  return `${id.tenantId}:${id.channel}:chat:${id.chatId}:user:${id.userId}`;
}

function resolveSessionId(cfg, ctx) {
  // Keep read/write path consistent: explicit conversation settings take precedence.
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

function shouldThrottleCapture(cfg, ctx, now = Date.now()) {
  if (!cfg.throttleMs || cfg.throttleMs <= 0) return false;
  const scopeKey = resolveScopeKey(cfg, ctx);
  const lastCaptureTime = captureTimes.get(scopeKey) ?? 0;
  if (now - lastCaptureTime < cfg.throttleMs) return true;
  captureTimes.set(scopeKey, now);
  return false;
}

function buildSearchPayload(cfg, prompt, ctx) {
  const queryRaw = `${cfg.queryPrefix || ""}${prompt}`;
  const query =
    Number.isFinite(cfg.maxQueryChars) && cfg.maxQueryChars > 0
      ? queryRaw.slice(0, cfg.maxQueryChars)
      : queryRaw;
  const userId = resolveUserId(cfg, ctx);

  const payload = {
    user_id: userId,
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

function buildAddMessagePayload(cfg, messages, ctx) {
  const asyncMode = cfg.memoryWriteAsync ? "async" : "sync";
  const identity = buildIdentity(cfg, ctx);
  const payload = {
    user_id: identity.userId,
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

export default {
  id: "memos-cloud-openclaw-plugin",
  name: "MemOS Cloud OpenClaw Plugin",
  description: "MemOS Cloud recall + add memory via lifecycle hooks",
  kind: "lifecycle",

  register(api) {
    const cfg = buildConfig(api.pluginConfig);
    const log = api.logger ?? console;

    if (!cfg.envFileStatus?.found) {
      const searchPaths = cfg.envFileStatus?.searchPaths?.join(", ") ?? ENV_FILE_SEARCH_HINTS.join(", ");
      log.warn?.(`[memos-cloud] No .env found in ${searchPaths}; falling back to process env or plugin config.`);
    }

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
      if (!cfg.apiKey) {
        warnMissingApiKey(log, "recall");
        return;
      }
      const traceId = makeTraceId();
      const startedAt = Date.now();

      try {
        const payload = buildSearchPayload(cfg, event.prompt, ctx);
        const cacheKey = `${payload.session_id}:${payload.top_k}:${payload.relativity}:${payload.query}`;
        const cached = readRecallCache(cacheKey);
        if (cached) {
          logEvent(log, "info", "recall.cache_hit", {
            trace_id: traceId,
            scope_key: payload.session_id,
          });
          return { prependContext: cached };
        }

        const result = await searchMemory(
          { ...cfg, timeoutMs: cfg.memorySearchTimeoutMs, retries: 0 },
          payload,
        );
        const promptBlock = formatPromptBlock(result, {
          wrapTagBlocks: true,
          relativity: payload.relativity,
          maxOutputChars: cfg.memoryBudgetTokens * 4,
        });
        if (!promptBlock) return;
        writeRecallCache(cacheKey, promptBlock, cfg.memoryCacheTtlSec);

        logEvent(log, "info", "recall.success", {
          trace_id: traceId,
          cost_ms: Date.now() - startedAt,
          scope_key: payload.session_id,
          prompt_chars: promptBlock.length,
          cache_ttl_sec: cfg.memoryCacheTtlSec,
        });

        return {
          prependContext: promptBlock,
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
      if (shouldThrottleCapture(cfg, ctx, now)) {
        return;
      }

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
