# MemOS Cloud OpenClaw Plugin（Lifecycle 插件）

官方维护：MemTensor。

这是一个具备 Edge-First (边缘优先) 架构的 OpenClaw lifecycle 插件，功能是：
- **召回记忆**：在每轮对话前优先从本地 LanceDB 秒级检索记忆并注入上下文（支持远端 MemOS 兜底）
- **添加记忆**：极速写回本地并异步冷备至 MemOS Cloud

## 功能
- **Zero Latency**: 本地优先，无惧网络抖动，彻底解放 Node.js 事件循环
- **Recall**：`before_agent_start` → 本地 LanceDB 检索 → (可选兜底) `/search/memory`
- **Add**：`agent_end` → 同步写入本地 LanceDB + 异步 `/add/message` 备份
- 使用 **Token** 认证（`Authorization: Token <MEMOS_API_KEY>`）进行数据同步

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
- `MEMOS_BASE_URL`（默认 `https://memos.memtensor.cn/api/openmem/v1`）
- `MEMOS_API_KEY`（必填，Token 认证）—— 获取地址：https://memos-dashboard.openmem.net/cn/apikeys/
- `MEMOS_USER_ID`（可选，默认 `openclaw-user`）
- `MEMOS_CONVERSATION_ID`（可选覆盖）
- `MEMOS_RECALL_GLOBAL`（默认 `true`；为 true 时检索不传 conversation_id）
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX`（可选）
- `MEMOS_CONVERSATION_SUFFIX_MODE`（`none` | `counter`，默认 `none`）
- `MEMOS_CONVERSATION_RESET_ON_NEW`（默认 `true`，需 hooks.internal.enabled）

## 可选插件配置
在 `plugins.entries.memos-cloud-openclaw-plugin.config` 中设置：
```json
{
  "baseUrl": "https://memos.memtensor.cn/api/openmem/v1",
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
  "syncToCloud": true,
  "fallbackToCloud": true,
  "lancedb": {
    "enabled": true,
    "embedder": {
      "model": "text-embedding-3-small"
    }
  }
}
```

## 工作原理
### 1) 召回（before_agent_start）
- **触发断路器**：首先在本地 LanceDB 执行基于向量与 FTS 全文索引的混合检索。由于是本地查询，此步网络延迟近乎为 0。
- **本地直接返回**：如果本地检索分数达标，直接拼装上下文返回给大模型。
- **云端兜底检索**：如果本地分数过低或未命中，且开启了 `fallbackToCloud`，则向远端发送 `/search/memory` 获取兜底数据。

### 2) 添加（agent_end）
- **本地秒级落盘**：提取最后一轮会话并在内部生成向量（Embed），同步执行 LanceDB 的存储保证本地落盘，以便下一轮能够立即检索到刚说的话。
- **云端异步冷备**：通过开启 `syncToCloud=true`，后台使用“发后不管”的形式发送异步 `/add/message` 请求上报远端 MemOS，此时即便没有网络也不会阻塞 Agent。

## 说明
- 未显式指定 `conversation_id` 时，默认使用 OpenClaw `sessionKey`。**TODO**：后续考虑直接绑定 OpenClaw `sessionId`。
- 可配置前后缀；`conversationSuffixMode=counter` 时会在 `/new` 递增（需 `hooks.internal.enabled`）。

## 致谢
- 感谢 @anatolykoptev（Contributor）— 领英：https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
