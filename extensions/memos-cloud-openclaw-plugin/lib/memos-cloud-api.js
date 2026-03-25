import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL = "https://memos.memtensor.cn";
export const USER_QUERY_MARKER = "user\u200b原\u200b始\u200bquery\u200b：\u200b\u200b\u200b\u200b";
const ENV_SOURCES = [
  { name: "openclaw", path: join(homedir(), ".openclaw", ".env") },
  { name: "moltbot", path: join(homedir(), ".moltbot", ".env") },
  { name: "clawdbot", path: join(homedir(), ".clawdbot", ".env") },
];

let envFilesLoaded = false;
const envFileContents = new Map();
const envFileValues = new Map();

function stripQuotes(value) {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractResultData(result) {
  if (!result || typeof result !== "object") return null;
  const candidates = [
    result.data?.data,
    result.data?.result,
    result.result?.data,
    result.result,
    result.data,
  ];

  const looksLikeMemoryPayload = (value) =>
    value &&
    typeof value === "object" &&
    (Array.isArray(value.memory_detail_list) ||
      Array.isArray(value.preference_detail_list) ||
      Array.isArray(value.tool_memory_detail_list) ||
      value.preference_note !== undefined);

  for (const candidate of candidates) {
    if (looksLikeMemoryPayload(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") return candidate;
  }

  return null;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTime(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
      date.getHours(),
    )}:${pad2(date.getMinutes())}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^\d+$/.test(trimmed)) return formatTime(Number(trimmed));
    return trimmed;
  }
  return "";
}

function parseEnvFile(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1);
    if (!key) continue;
    values.set(key, stripQuotes(rawValue));
  }
  return values;
}

function loadEnvFiles() {
  if (envFilesLoaded) return;
  envFilesLoaded = true;
  for (const source of ENV_SOURCES) {
    try {
      const content = readFileSync(source.path, "utf-8");
      envFileContents.set(source.name, content);
      envFileValues.set(source.name, parseEnvFile(content));
    } catch {
      // ignore missing files
    }
  }
}

function loadEnvFromFiles(name) {
  for (const source of ENV_SOURCES) {
    const values = envFileValues.get(source.name);
    if (!values) continue;
    if (values.has(name)) return values.get(name);
  }
  return undefined;
}

function createEnvReader(options = {}) {
  const env = options.env ?? process.env;
  const skipEnvFiles = options.skipEnvFiles === true;

  return {
    load(name) {
      if (!skipEnvFiles) {
        loadEnvFiles();
        const fromFiles = loadEnvFromFiles(name);
        if (fromFiles !== undefined) return fromFiles;
      }
      return env[name];
    },
    status() {
      if (skipEnvFiles) {
        return {
          found: false,
          sources: [],
          paths: [],
          searchPaths: ENV_SOURCES.map((source) => source.path),
        };
      }
      loadEnvFiles();
      const sources = ENV_SOURCES.filter((source) => envFileContents.has(source.name));
      return {
        found: sources.length > 0,
        sources: sources.map((source) => source.name),
        paths: sources.map((source) => source.path),
        searchPaths: ENV_SOURCES.map((source) => source.path),
      };
    },
  };
}

function loadEnvVar(name) {
  return createEnvReader().load(name);
}

export function getEnvFileStatus(options = {}) {
  return createEnvReader(options).status();
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function normalizeEnum(value, allowedValues, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

export function buildConfig(pluginConfig = {}, options = {}) {
  const cfg = pluginConfig ?? {};
  const envReader = createEnvReader(options);
  const env = (name) => envReader.load(name);

  const baseUrl = cfg.baseUrl || env("MEMOS_BASE_URL") || DEFAULT_BASE_URL;
  const apiKey = cfg.apiKey || env("MEMOS_API_KEY") || "";
  const userId = cfg.userId || env("MEMOS_USER_ID") || "openclaw-user";
  const conversationId = cfg.conversationId || env("MEMOS_CONVERSATION_ID") || "";

  const recallGlobal = parseBool(
    cfg.recallGlobal,
    parseBool(env("MEMOS_RECALL_GLOBAL"), true),
  );

  const conversationIdPrefix = cfg.conversationIdPrefix ?? env("MEMOS_CONVERSATION_PREFIX") ?? "";
  const conversationIdSuffix = cfg.conversationIdSuffix ?? env("MEMOS_CONVERSATION_SUFFIX") ?? "";
  const conversationSuffixMode = normalizeEnum(
    cfg.conversationSuffixMode ?? env("MEMOS_CONVERSATION_SUFFIX_MODE"),
    ["none", "counter"],
    "none",
  );
  const resetOnNew = parseBool(
    cfg.resetOnNew,
    parseBool(env("MEMOS_CONVERSATION_RESET_ON_NEW"), true),
  );

  const captureStrategy = normalizeEnum(cfg.captureStrategy, ["last_turn", "full_session"], "last_turn");
  const relativity = clampNumber(
    cfg.relativity ?? env("MEMOS_RELATIVITY") ?? 0.45,
    0,
    1,
    0.45,
  );
  const memoryEnabled = parseBool(
    cfg.memoryEnabled ?? env("MEMORY_ENABLED"),
    true,
  );
  const memoryTopK = clampInt(
    cfg.memoryTopK ?? cfg.memoryLimitNumber ?? env("MEMORY_TOP_K") ?? 5,
    1,
    50,
    5,
  );
  const memoryBudgetTokens = clampInt(
    cfg.memoryBudgetTokens ?? env("MEMORY_BUDGET_TOKENS") ?? 800,
    100,
    8000,
    800,
  );
  const memorySearchTimeoutMs = clampInt(
    cfg.memorySearchTimeoutMs ?? cfg.timeoutMs ?? env("MEMORY_SEARCH_TIMEOUT_MS") ?? 1000,
    100,
    30000,
    1000,
  );
  const memoryWriteAsync = parseBool(
    cfg.memoryWriteAsync ?? cfg.asyncMode ?? env("MEMORY_WRITE_ASYNC"),
    true,
  );
  const memoryWriteRetry = clampInt(
    cfg.memoryWriteRetry ?? cfg.retries ?? env("MEMORY_WRITE_RETRY") ?? 2,
    0,
    5,
    2,
  );
  const memoryCacheTtlSec = clampInt(
    cfg.memoryCacheTtlSec ?? env("MEMORY_CACHE_TTL_SEC") ?? 60,
    0,
    3600,
    60,
  );
  const memoryScopeMode = normalizeEnum(
    cfg.memoryScopeMode ?? env("MEMORY_SCOPE_MODE"),
    ["user", "chat", "hybrid"],
    "hybrid",
  );
  const memoryPiiFilterEnabled = parseBool(
    cfg.memoryPiiFilterEnabled ?? env("MEMORY_PII_FILTER_ENABLED"),
    true,
  );
  const memoryDegradeOnError = parseBool(
    cfg.memoryDegradeOnError ?? env("MEMORY_DEGRADE_ON_ERROR"),
    true,
  );
  const memoryGrayPercent = clampInt(
    cfg.memoryGrayPercent ?? env("MEMORY_GRAY_PERCENT") ?? 100,
    0,
    100,
    100,
  );
  const memosSearchFallbackEnabled = parseBool(
    cfg.memosSearchFallbackEnabled ?? env("MEMOS_SEARCH_FALLBACK_ENABLED"),
    false,
  );
  const memosSearchFallbackMode = normalizeEnum(
    cfg.memosSearchFallbackMode ?? env("MEMOS_SEARCH_FALLBACK_MODE"),
    ["empty-only", "weak-or-empty"],
    "empty-only",
  );
  const memosSearchFallbackMinScore = clampNumber(
    cfg.memosSearchFallbackMinScore ?? env("MEMOS_SEARCH_FALLBACK_MIN_SCORE") ?? 0.45,
    0,
    1,
    0.45,
  );
  const tenantId = cfg.tenantId ?? env("MEMORY_TENANT_ID") ?? "default";
  const channel = cfg.channel ?? env("MEMORY_CHANNEL") ?? "openclaw";
  const platform = cfg.platform ?? env("MEMORY_PLATFORM") ?? "openclaw";
  const allowedAgentIds = Array.isArray(cfg.allowedAgentIds)
    ? cfg.allowedAgentIds.filter((item) => typeof item === "string" && item.trim())
    : [];
  const dynamicUserIdFormat = cfg.dynamicUserIdFormat ?? env("MEMOS_DYNAMIC_USER_ID_FORMAT") ?? "agent";
  const dynamicTagMode = cfg.dynamicTagMode ?? env("MEMOS_DYNAMIC_TAG_MODE") ?? "agent-and-memos";
  const dynamicConversationPrefixMode =
    cfg.dynamicConversationPrefixMode ?? env("MEMOS_DYNAMIC_CONVERSATION_PREFIX_MODE") ?? "agent";

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    userId,
    conversationId,
    conversationIdPrefix,
    conversationIdSuffix,
    conversationSuffixMode,
    recallGlobal,
    resetOnNew,
    envFileStatus: envReader.status(),
    queryPrefix: cfg.queryPrefix ?? "",
    maxQueryChars: cfg.maxQueryChars ?? 0,
    recallEnabled: cfg.recallEnabled !== false,
    addEnabled: cfg.addEnabled !== false,
    captureStrategy,
    maxMessageChars: cfg.maxMessageChars ?? 20000,
    includeAssistant: cfg.includeAssistant !== false,
    memoryLimitNumber: memoryTopK,
    preferenceLimitNumber: cfg.preferenceLimitNumber ?? 6,
    includePreference: cfg.includePreference !== false,
    includeToolMemory: cfg.includeToolMemory === true,
    toolMemoryLimitNumber: cfg.toolMemoryLimitNumber ?? 6,
    relativity,
    filter: cfg.filter,
    knowledgebaseIds: cfg.knowledgebaseIds ?? [],
    tags: cfg.tags ?? ["openclaw"],
    info: cfg.info ?? {},
    agentId: cfg.agentId,
    allowedAgentIds,
    dynamicUserIdFormat,
    dynamicTagMode,
    dynamicConversationPrefixMode,
    appId: cfg.appId,
    allowPublic: cfg.allowPublic ?? false,
    allowKnowledgebaseIds: cfg.allowKnowledgebaseIds ?? [],
    asyncMode: cfg.asyncMode ?? true,
    timeoutMs: cfg.timeoutMs ?? 5000,
    retries: cfg.retries ?? 1,
    throttleMs: cfg.throttleMs ?? 0,
    memoryEnabled,
    memoryTopK,
    memoryBudgetTokens,
    memorySearchTimeoutMs,
    memoryWriteAsync,
    memoryWriteRetry,
    memoryCacheTtlSec,
    memoryScopeMode,
    memoryPiiFilterEnabled,
    memoryDegradeOnError,
    memoryGrayPercent,
    memosSearchFallbackEnabled,
    memosSearchFallbackMode,
    memosSearchFallbackMinScore,
    tenantId,
    channel,
    platform,
    lancedb: cfg.lancedb,
  };
}

export async function callApi({ baseUrl, apiKey, timeoutMs = 5000, retries = 1 }, path, body) {
  if (!apiKey) {
    throw new Error("Missing MEMOS API key (Token auth)");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Token ${apiKey}`,
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await delay(100 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

export async function searchMemory(cfg, payload) {
  return callApi(cfg, "/product/search", payload);
}

export async function addMessage(cfg, payload) {
  return callApi(cfg, "/product/add", payload);
}

export function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && block.type === "text")
      .map((block) => block.text)
      .join(" ");
  }
  return "";
}

function normalizePreferenceType(value) {
  if (!value) return "";
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("explicit")) return "Explicit Preference";
  if (normalized.includes("implicit")) return "Implicit Preference";
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function sanitizeInlineText(text) {
  if (text === undefined || text === null) return "";
  return String(text).replace(/\r?\n+/g, " ").trim();
}

function formatMemoryLine(item, text, options = {}) {
  const cleaned = sanitizeInlineText(text);
  if (!cleaned) return "";
  const maxChars = options.maxItemChars;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time);
  if (time) return `   -[${time}] ${truncated}`;
  return `   - ${truncated}`;
}

function formatPreferenceLine(item, text, options = {}) {
  const cleaned = sanitizeInlineText(text);
  if (!cleaned) return "";
  const maxChars = options.maxItemChars;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time);
  const type = normalizePreferenceType(item?.preference_type);
  const typeLabel = type ? ` [${type}]` : "";
  if (time) return `   -[${time}]${typeLabel} ${truncated}`;
  return `   -${typeLabel} ${truncated}`;
}

function wrapCodeBlock(lines, options = {}) {
  if (!options.wrapTagBlocks) return lines;
  return ["```text", ...lines, "```"];
}

function buildPromptFromData(data, options = {}) {
  const now = options.currentTime ?? Date.now();
  const nowText = formatTime(now) || formatTime(Date.now()) || "";
  const memoryList = data?.memory_detail_list ?? [];
  const preferenceList = data?.preference_detail_list ?? [];

  const memoryLines = memoryList
    .filter((item) => {
      const score = item?.relativity ?? 1;
      const threshold = options.relativity ?? 0;
      return score > threshold;
    })
    .map((item) => {
      const text = item?.memory_value || item?.memory_key || "";
      return formatMemoryLine(item, text, options);
    })
    .filter(Boolean);

  const preferenceLines = preferenceList
    .filter((item) => {
      const score = item?.relativity ?? 1;
      const threshold = options.relativity ?? 0;
      return score > threshold;
    })
    .map((item) => {
      const text = item?.preference || "";
      return formatPreferenceLine(item, text, options);
    })
    .filter(Boolean);

  const hasContent = memoryLines.length > 0 || preferenceLines.length > 0;

  if (!hasContent) return "";

  const memoriesBlock = [
    "<memories>",
    "  <facts>",
    ...memoryLines,
    "  </facts>",
    "  <preferences>",
    ...preferenceLines,
    "  </preferences>",
    "</memories>",
  ];

  const lines = [
    "# Role",
    "",
    "You are an intelligent assistant with long-term memory capabilities (MemOS Assistant). Your goal is to combine retrieved memory fragments to provide highly personalized, accurate, and logically rigorous responses.",
    "",
    "# System Context",
    "",
    `* Current Time: ${nowText} (Use this as the baseline for freshness checks)`,
    "",
    "# Memory Data",
    "",
    'Below is the information retrieved by MemOS, categorized into "Facts" and "Preferences".',
    "* **Facts**: May include user attributes, historical conversations, or third-party details.",
    "* **Special Note**: Content tagged with '[assistant观点]' or '[模型总结]' represents **past AI inference**, **not** direct user statements.",
    "* **Preferences**: The user's explicit or implicit requirements on response style, format, or reasoning.",
    "",
    ...wrapCodeBlock(memoriesBlock, options),
    "",
    "# Critical Protocol: Memory Safety",
    "",
    "Retrieved memories may contain **AI speculation**, **irrelevant noise**, or **wrong subject attribution**. You must strictly apply the **Four-Step Verdict**. If any step fails, **discard the memory**:",
    "",
    "1. **Source Verification**:",
    "* **Core**: Distinguish direct user statements from AI inference.",
    "* If a memory has tags like '[assistant观点]' or '[模型总结]', treat it as a **hypothesis**, not a user-grounded fact.",
    "* *Counterexample*: If memory says '[assistant观点] User loves mangoes' but the user never said that, do not assume it as fact.",
    "* **Principle: AI summaries are reference-only and have much lower authority than direct user statements.**",
    "",
    "2. **Attribution Check**:",
    "* Is the subject in memory definitely the user?",
    "* If the memory describes a **third party** (e.g., candidate, interviewee, fictional character, case data), never attribute it to the user.",
    "",
    "3. **Strong Relevance Check**:",
    "* Does the memory directly help answer the current 'Original Query'?",
    "* If it is only a keyword overlap with different context, ignore it.",
    "",
    "4. **Freshness Check**:",
    "* If memory conflicts with the user's latest intent, prioritize the current 'Original Query' as the highest source of truth.",
    "",
    "# Instructions",
    "",
    "1. **Review**: Read '<facts>' first and apply the Four-Step Verdict to remove noise and unreliable AI inference.",
    "2. **Execute**:",
    "   - Use only memories that pass filtering as context.",
    "   - Strictly follow style requirements from '<preferences>'.",
    "3. **Output**: Answer directly. Never mention internal terms such as \"memory store\", \"retrieval\", or \"AI opinions\".",
    "4. **Attention**: Additional memory context is already provided. Do not read from or write to local `MEMORY.md` or `memory/*` files for reference, as they may be outdated or irrelevant to the current query.",
    USER_QUERY_MARKER,
  ];

  const block = lines.join("\n");
  const maxOutputChars = options.maxOutputChars;
  if (Number.isFinite(maxOutputChars) && maxOutputChars > 0 && block.length > maxOutputChars) {
    // Preserve query marker so downstream stripping logic can always find it.
    if (maxOutputChars <= USER_QUERY_MARKER.length) return USER_QUERY_MARKER;
    const headBudget = Math.max(0, maxOutputChars - USER_QUERY_MARKER.length - 1);
    const head = block.slice(0, headBudget).trimEnd();
    return `${head}\n${USER_QUERY_MARKER}`;
  }
  return block;
}

export function formatContextBlock(result, options = {}) {
  const data = extractResultData(result);
  if (!data) return "";

  const memoryList = data.memory_detail_list ?? [];
  const prefList = data.preference_detail_list ?? [];
  const toolList = data.tool_memory_detail_list ?? [];
  const preferenceNote = data.preference_note;

  const lines = [];
  if (memoryList.length > 0) {
    lines.push("Facts:");
    for (const item of memoryList) {
      const text = item?.memory_value || item?.memory_key || "";
      if (!text) continue;
      lines.push(`- ${truncate(text, options.maxItemChars)}`);
    }
  }

  if (prefList.length > 0) {
    lines.push("Preferences:");
    for (const item of prefList) {
      const pref = item?.preference || "";
      const type = item?.preference_type ? `(${item.preference_type}) ` : "";
      if (!pref) continue;
      lines.push(`- ${type}${truncate(pref, options.maxItemChars)}`);
    }
  }

  if (toolList.length > 0) {
    lines.push("Tool Memories:");
    for (const item of toolList) {
      const value = item?.tool_value || "";
      if (!value) continue;
      lines.push(`- ${truncate(value, options.maxItemChars)}`);
    }
  }

  if (preferenceNote) {
    lines.push(`Preference Note: ${truncate(preferenceNote, options.maxItemChars)}`);
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

export function formatPromptBlock(result, options = {}) {
  const data = extractResultData(result);
  if (!data) return "";
  return buildPromptFromData(data, options);
}

function truncate(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
