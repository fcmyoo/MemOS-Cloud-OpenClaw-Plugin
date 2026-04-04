# MemOS Cloud OpenClaw Plugin（Lifecycle 插件）

官方维护：MemTensor。

这是一个最小可用的 OpenClaw lifecycle 插件，功能是：
- **召回记忆**：在每轮对话前从 MemOS Cloud 检索记忆并注入上下文
- **添加记忆**：在每轮对话结束后把消息写回 MemOS Cloud

## 功能
- **Recall**：`before_agent_start` → `/product/search`
- **Add**：`agent_end` → `/product/add`
- 使用请求头认证（`Authorization: <MEMOS_API_KEY>`）

## 安装

### 方式 A — NPM（推荐）
```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

> **Windows 用户注意**：
> 如果遇到 `Error: spawn EINVAL` 报错，这是 OpenClaw Windows 安装器的已知问题。请使用下方的 **方式 B**（手动安装）。

确认 `~/.openclaw/openclaw.json` 中已启用：
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    }
  }
}
```

### 方式 B — 手动安装（Windows 解决方案）
1. 从 [NPM](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin) 下载最新的 `.tgz` 包。
2. 解压到本地目录（例如 `C:\Users\YourName\.openclaw\extensions\memos-cloud-openclaw-plugin`）。
3. 修改配置 `~/.openclaw/openclaw.json`（或 `%USERPROFILE%\.openclaw\openclaw.json`）：

```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    },
    "load": {
      "paths": [
        "C:\\Users\\YourName\\.openclaw\\extensions\\memos-cloud-openclaw-plugin\\package"
      ]
    }
  }
}
```
*注意：解压后的文件夹通常包含一个 `package` 子文件夹，请指向包含 `package.json` 的那层目录。*

修改配置后需要重启 gateway。

## 环境变量
插件按顺序读取 env 文件（**openclaw → moltbot → clawdbot**），每个键优先使用最先匹配到的值。
若该键在三个文件中都未找到，会按“键级别”回退到进程环境变量。

**配置位置**
- 文件（优先级顺序）：
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- 每行格式：`KEY=value`

**快速配置（Shell）**
```bash
echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.zshrc
source ~/.zshrc
# 或者

echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.bashrc
source ~/.bashrc
```

**快速配置（Windows PowerShell）**
```powershell
[System.Environment]::SetEnvironmentVariable("MEMOS_API_KEY", "mpg-...", "User")
```

若未读取到 `MEMOS_API_KEY`，插件会提示配置方式并附 API Key 获取地址。

**最小配置**
```env
MEMOS_API_KEY=YOUR_TOKEN
```

**可选配置**
- `MEMOS_BASE_URL`（默认 `https://memos.memtensor.cn`）
- `MEMOS_API_KEY`（必填，以 `Authorization` 请求头发送）—— 获取地址：https://memos-dashboard.openmem.net/cn/apikeys/
- `MEMOS_USER_ID`（可选；未设置时优先派生为运行时 `openclaw_<agentId>`，否则回退为 `openclaw-user`）
- `MEMOS_CONVERSATION_ID`（可选覆盖）
- `MEMOS_RECALL_GLOBAL`（默认 `true`；为 true 时检索不传 conversation_id）
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX`（可选）
- `MEMOS_CONVERSATION_SUFFIX_MODE`（`none` | `counter`，默认 `none`）
- `MEMOS_CONVERSATION_RESET_ON_NEW`（默认 `true`，需 hooks.internal.enabled）
- `MEMORY_ENABLED`（默认 `true`）
- `MEMORY_TOP_K`（默认 `5`）
- `MEMORY_BUDGET_TOKENS`（默认 `800`，用于限制注入上下文大小）
- `MEMORY_SEARCH_TIMEOUT_MS`（默认 `1000`）
- `MEMORY_WRITE_ASYNC`（默认 `true`）
- `MEMORY_WRITE_RETRY`（默认 `2`）
- `MEMORY_CACHE_TTL_SEC`（默认 `60`）
- `MEMORY_SCOPE_MODE`（`user` | `chat` | `hybrid`，默认 `hybrid`）
- `MEMORY_PII_FILTER_ENABLED`（默认 `true`，当前为预留开关）
- `MEMORY_DEGRADE_ON_ERROR`（默认 `true`）
- `MEMORY_GRAY_PERCENT`（默认 `100`，灰度流量比例，范围 `0-100`）

## 可选插件配置
在 `plugins.entries.memos-cloud-openclaw-plugin.config` 中设置：
```json
{
  "baseUrl": "https://memos.memtensor.cn",
  "apiKey": "YOUR_API_KEY",
  "userId": "memos_user_123",
  "conversationId": "openclaw-main",
  "queryPrefix": "important user context preferences decisions ",
  "recallEnabled": true,
  "recallGlobal": true,
  "addEnabled": true,
  "captureStrategy": "last_turn",
  "includeAssistant": true,
  "conversationIdPrefix": "",
  "conversationIdSuffix": "",
  "conversationSuffixMode": "none",
  "resetOnNew": true,
  "memoryLimitNumber": 6,
  "preferenceLimitNumber": 6,
  "knowledgebaseIds": [],
  "includePreference": true,
  "includeToolMemory": false,
  "toolMemoryLimitNumber": 6,
  "tags": ["openclaw"],
  "asyncMode": true
}
```

## 工作原理
### 1) 召回（before_agent_start）
- 组装 `/product/search` 请求
  - `user_id`、`query`（= prompt + 可选前缀）
  - `session_id` 由 `MEMORY_SCOPE_MODE` 计算（`user/chat/hybrid`）
  - 可选 `filter` / `readable_cube_ids`
- 使用 `/product/search` 结果按 MemOS 提示词模板（Role/System/Memory/Skill/Protocols）拼装，并通过 `prependContext` 注入
  - 注入会受 `MEMORY_BUDGET_TOKENS` 限制，并使用短缓存（`MEMORY_CACHE_TTL_SEC`）

### 2) 添加（agent_end）
- 默认只写**最后一轮**（user + assistant）
- 构造 `/product/add` 请求：
  - `user_id`、`session_id`
  - `messages` 列表
  - 可选 `custom_tags / info / writable_cube_ids`
  - `async_mode` 由 `MEMORY_WRITE_ASYNC` 控制

## 说明
- `session_id` 默认由 `tenantId + channel + scope` 组合生成；可继续通过 `conversationId` 系列配置强制覆盖。
- 可配置前后缀；`conversationSuffixMode=counter` 时会在 `/new` 递增（需 `hooks.internal.enabled`）。
- 当 MemOS 检索/写入失败且 `MEMORY_DEGRADE_ON_ERROR=true` 时，插件自动降级，不阻塞主对话。
- 支持稳定灰度：基于 `scope_key` 哈希分流，`MEMORY_GRAY_PERCENT=10` 表示约 10% 会话启用记忆增强。

## 致谢
- 感谢 @anatolykoptev（Contributor）— 领英：https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
