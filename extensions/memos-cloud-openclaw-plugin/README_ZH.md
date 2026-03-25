# MemOS Cloud OpenClaw Plugin

> **官方维护**：MemTensor | **版本**：0.1.7 | **协议**：MIT

一个为 OpenClaw / MoltBot / ClawdBot 设计的 **lifecycle 记忆增强插件**，
提供 **双层混合检索**（本地 LanceDB + 云端 MemOS Cloud），让每个 AI Agent 拥有持久、精准、隔离的长期记忆能力。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 📥 **记忆召回** | `before_agent_start` 触发，将相关记忆注入对话上下文 |
| 📤 **记忆写入** | `agent_end` 触发，将每轮对话自动写回记忆库 |
| 🏠 **本地精准层** | LanceDB 向量搜索 + BM25 → RRF 融合 → Cross-Encoder 重排 → MMR 去重 |
| ☁️ **云端知识层** | MemOS Cloud 结构化记忆（事实/偏好/工具记忆/技能记忆） |
| 🤖 **多 Agent 隔离** | 每个 Agent 独立记忆空间，`ctx.agentId` 自动路由，零配置隔离 |
| ⚡ **性能优化** | Embedding LRU 缓存、Recall 结果缓存、节流限制、异步写入 |

---

## 适用平台

本插件基于标准 OpenClaw lifecycle 协议，可在以下平台使用（只要平台支持 lifecycle 插件）：

- **OpenClaw** / **MoltBot** / **ClawdBot**（原生支持）
- **Claude Desktop** / **Cursor** / **Codex** / **Gemini CLI**（需通过 OpenClaw Gateway 桥接）
- **Antigravity** / 自定义 AI 工具（通过 `before_agent_start` / `agent_end` hook 接入）

---

## 安装

### 方式 A — NPM（推荐）

```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

### 方式 B — 本地 Archive 安装

```bash
openclaw plugins install --source archive /path/to/memos-cloud-openclaw-plugin.tgz
openclaw gateway restart
```

### 方式 C — 手动安装（Windows）

1. 从 [NPM](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin) 下载 `.tgz` 包
2. 解压到 `~/.openclaw/extensions/memos-cloud-openclaw-plugin/`
3. 在 `openclaw.json` 中手动添加 `plugins.load.paths` 指向该目录

---

## 快速配置

### 第一步：获取 API Key

- MemOS API Key：[https://memos-dashboard.openmem.net/cn/apikeys/](https://memos-dashboard.openmem.net/cn/apikeys/)
- SiliconFlow（BAAI/bge-m3 嵌入）：[https://siliconflow.cn/](https://siliconflow.cn/)
- Jina（Cross-Encoder 重排，可选）：[https://jina.ai/](https://jina.ai/)

### 第二步：配置 `~/.openclaw/openclaw.json`

```json
{
  "env": {
    "MEMOS_API_KEY": "krlk_your_memos_api_key_here"
  },
  "plugins": {
    "allow": ["memos-cloud-openclaw-plugin"],
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "enabled": true,
        "config": {
          "recallEnabled": true,
          "addEnabled": true,
          "allowedAgentIds": ["boss", "dev", "telegram", "private_assistant"],
          "dynamicUserIdFormat": "agent:user",
          "dynamicTagMode": "agent-only",
          "memoryScopeMode": "hybrid",
          "memosSearchFallbackEnabled": true,
          "memosSearchFallbackMode": "weak-or-empty",
          "lancedb": {
            "enabled": true,
            "dbPath": "~/.openclaw/memory/lancedb",
            "embedder": {
              "apiKey": "sk-your_siliconflow_key",
              "baseURL": "https://api.siliconflow.cn/v1",
              "model": "BAAI/bge-m3",
              "dimensions": 1024
            }
          }
        }
      }
    }
  }
}
```

### 第三步：重启 Gateway

```bash
openclaw gateway restart
```

---

## 完整配置参考

```json
{
  "memos-cloud-openclaw-plugin": {
    "enabled": true,
    "config": {

      "=== MemOS Cloud 连接 ===": "",
      "baseUrl": "https://memos.memtensor.cn",
      "apiKey": "",
      "userId": "openclaw-user",

      "=== 多 Agent 控制 ===": "",
      "allowedAgentIds": ["boss", "dev", "telegram"],
      "dynamicUserIdFormat": "agent:user",
      "dynamicConversationPrefixMode": "agent",
      "dynamicTagMode": "agent-only",
      "memoryScopeMode": "hybrid",

      "=== 召回行为 ===": "",
      "recallEnabled": true,
      "recallGlobal": false,
      "memoryLimitNumber": 6,
      "preferenceLimitNumber": 6,
      "includePreference": true,
      "includeToolMemory": false,
      "memoryCacheTtlSec": 120,

      "=== 写入行为 ===": "",
      "addEnabled": true,
      "captureStrategy": "last_turn",
      "includeAssistant": true,
      "maxMessageChars": 20000,
      "asyncMode": true,
      "retries": 1,
      "throttleMs": 5000,

      "=== MemOS 云端兜底 ===": "",
      "memosSearchFallbackEnabled": true,
      "memosSearchFallbackMode": "weak-or-empty",
      "memosSearchFallbackMinScore": 0.4,

      "=== LanceDB 本地精准层 ===": "",
      "lancedb": {
        "enabled": true,
        "dbPath": "~/.openclaw/memory/lancedb",
        "embedder": {
          "apiKey": "sk-your_siliconflow_key",
          "baseURL": "https://api.siliconflow.cn/v1",
          "model": "BAAI/bge-m3",
          "dimensions": 1024
        },
        "vectorWeight": 0.7,
        "bm25Weight": 0.3,
        "topK": 6,
        "candidatePoolSize": 20,
        "hardMinScore": 0.35,
        "rerank": "cross-encoder",
        "rerankApiKey": "jina_your_rerank_key",
        "rerankModel": "jina-reranker-v3",
        "rerankEndpoint": "https://api.jina.ai/v1/rerank",
        "recencyWeight": 0.1,
        "recencyHalfLifeDays": 14,
        "filterNoise": true
      }
    }
  }
}
```

---

## 环境变量支持

插件按如下优先级顺序读取变量：

```
~/.openclaw/.env  →  ~/.moltbot/.env  →  ~/.clawdbot/.env  →  process.env
```

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MEMOS_API_KEY` | — | **必填**，MemOS Token 认证 |
| `MEMOS_BASE_URL` | `https://memos.memtensor.cn` | MemOS 服务地址 |
| `MEMOS_USER_ID` | `openclaw-user` | 静态 user_id（多 Agent 时被 dynamic 覆盖） |
| `MEMOS_RECALL_GLOBAL` | `true` | 全局召回（不传 conversation_id） |
| `MEMOS_DYNAMIC_USER_ID_FORMAT` | `agent` | `agent` 或 `agent:user` |
| `MEMOS_DYNAMIC_TAG_MODE` | `agent-and-memos` | `agent-only` / `agent-and-memos` / `inherit` |
| `MEMOS_DYNAMIC_CONVERSATION_PREFIX_MODE` | `agent` | `agent` 或 `inherit` |
| `MEMORY_SCOPE_MODE` | `hybrid` | `user` / `chat` / `hybrid` |
| `MEMORY_CACHE_TTL_SEC` | `60` | 召回结果缓存时间（秒） |
| `MEMORY_DEGRADE_ON_ERROR` | `true` | 错误时优雅降级（不抛异常） |
| `LANCEDB_EMBED_API_KEY` | — | LanceDB Embedder API Key |
| `LANCEDB_EMBED_BASE_URL` | `https://api.siliconflow.cn/v1` | Embedder 地址 |
| `JINA_RERANK_API_KEY` | — | Jina Cross-Encoder Reranker Key |

---

## 工作原理

### 召回流程（`before_agent_start`）

```
用户消息 → 提取查询词（resolveRecallQuery）
         → [可选] 命中召回缓存 → 直接返回
         → LanceDB 本地召回
             Embed 查询词 → 向量搜索 + BM25 检索
             → RRF 融合 → 时间衰减 Boost
             → Cross-Encoder 重排（如配置 Jina Key）
             → 长度归一化 → MMR 去重
         → getMemosFallbackDecision（判断是否需要云端兜底）
         → [按需] MemOS Cloud 召回
         → mergeAndFormat（融合双路结果）→ 注入 prependContext
```

### 写入流程（`agent_end`）

```
对话结束 → 节流检查（throttleMs）
         → isAgentAllowed 白名单检查
         → 提取消息（last_turn / full_session）
         → shouldWriteMessage 质量过滤
         → MemOS /product/add（异步）
         → LanceDB.store.add（同步写入本地向量库）
```

### 多 Agent 记忆隔离

```
ctx.agentId = "telegram"
  → userId    = "openclaw_telegram:user"       （dynamicUserIdFormat = "agent:user"）
  → sessionId = "telegram:{sessionKey}"         （dynamicConversationPrefixMode = "agent"）
  → scopeKey  = "default:openclaw:chat:{sessionKey}:user:openclaw_telegram:user"
  → tags      = ["telegram"]                    （dynamicTagMode = "agent-only"）
  → LanceDB scope filter: [scopeKey, "global"]  （只能看到自己的记忆）
```

---

## 多 Agent 最佳实践

### 场景 1：多 Bot 独立记忆

```json
{
  "allowedAgentIds": ["telegarm_bot", "feishu_bot", "discord_bot"],
  "dynamicUserIdFormat": "agent:user",
  "dynamicTagMode": "agent-only",
  "memoryScopeMode": "hybrid"
}
```

每个 Bot 自动使用 `ctx.agentId` 隔离，无需额外配置。

### 场景 2：Team 共享记忆（boss 读取 dev 的记忆）

目前需在 MemOS Cloud 侧配置 knowledgebase 共享，插件侧通过 `knowledgebaseIds` 引用。

### 场景 3：会话重置（/new 命令）

```json
{
  "conversationSuffixMode": "counter",
  "resetOnNew": true
}
```

需同时开启：
```json
{
  "hooks": { "internal": { "enabled": true } }
}
```

### 场景 4：灰度发布记忆功能

```json
{
  "memoryGrayPercent": 50
}
```

50% 的会话启用记忆，基于 `scopeKey` 哈希稳定分桶。

---

## 常见问题

### Q: 配置校验报 `must NOT have additional properties`

**原因**：`allowedAgentIds` 等字段在旧版 `openclaw.plugin.json` 的 schema 中未声明。

**解决**：
1. 更新插件到最新版：`openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest`
2. 或手动修改 `openclaw.plugin.json`，将相关字段加入 `configSchema.properties`（参考本 README）

### Q: 记忆没有生效（agent_skip 日志）

日志出现 `recall.agent_skip` → 检查 `allowedAgentIds` 是否包含当前 agent 的 ID。
日志出现 `add.agent_skip_missing_allowlist` → `allowedAgentIds` 为空数组，所有 agent 被屏蔽。

### Q: LanceDB 没有启用

检查：
1. `lancedb.enabled` 是否为 `true`
2. `lancedb.embedder.apiKey` 是否填写（或设置 `LANCEDB_EMBED_API_KEY` 环境变量）

### Q: MEMOS_API_TOKEN 不生效

插件读取的变量名是 `MEMOS_API_KEY`，不是 `MEMOS_API_TOKEN`。请修正 `env` 节点的键名。

### Q: Cross-Encoder 重排没工作

`rerank: "cross-encoder"` 需要配置 `rerankApiKey`（Jina API Key）或环境变量 `JINA_RERANK_API_KEY`。

---

## 致谢

- [@MemTensor](https://github.com/MemTensor) — 插件原作者与维护者
- [@anatolykoptev](https://www.linkedin.com/in/koptev) — 贡献者
- [LanceDB](https://lancedb.github.io/) — 本地向量数据库
- [Jina AI](https://jina.ai/) — Cross-Encoder 重排服务
