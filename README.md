# MemOS Cloud OpenClaw Plugin (Lifecycle)

Official plugin maintained by MemTensor.

A minimal OpenClaw lifecycle plugin that **recalls** memories from MemOS Cloud before each run and **adds** new messages to MemOS Cloud after each run.

## Features
- **Recall**: `before_agent_start` → `/product/search`
- **Add**: `agent_end` → `/product/add`
- Uses header auth (`Authorization: <MEMOS_API_KEY>`)

## Install

### Option A — NPM (Recommended)
```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

> **Note for Windows Users**:
> If you encounter `Error: spawn EINVAL`, this is a known issue with OpenClaw's plugin installer on Windows. Please use **Option B** (Manual Install) below.

Make sure it’s enabled in `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    }
  }
}
```

### Option B — Manual Install (Workaround for Windows)
1. Download the latest `.tgz` from [NPM](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin).
2. Extract it to a local folder (e.g., `C:\Users\YourName\.openclaw\extensions\memos-cloud-openclaw-plugin`).
3. Configure `~/.openclaw/openclaw.json` (or `%USERPROFILE%\.openclaw\openclaw.json`):

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
*Note: The extracted folder usually contains a `package` subfolder. Point to the folder containing `package.json`.*

Restart the gateway after config changes.

## Environment Variables
The plugin tries env files in order (**openclaw → moltbot → clawdbot**). For each key, the first file with a value wins.
If a key is missing from all env files, it falls back to the process environment for that key.

**Where to configure**
- Files (priority order):
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- Each line is `KEY=value`

**Quick setup (shell)**
```bash
echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.zshrc
source ~/.zshrc
# or

echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.bashrc
source ~/.bashrc
```

**Quick setup (Windows PowerShell)**
```powershell
[System.Environment]::SetEnvironmentVariable("MEMOS_API_KEY", "mpg-...", "User")
```

If `MEMOS_API_KEY` is missing, the plugin will warn with setup instructions and the API key URL.

**Minimal config**
```env
MEMOS_API_KEY=YOUR_TOKEN
```

**Optional config**
- `MEMOS_BASE_URL` (default: `https://memos.memtensor.cn`)
- `MEMOS_API_KEY` (required; sent as `Authorization` header) — get it at https://memos-dashboard.openmem.net/cn/apikeys/
- `MEMOS_USER_ID` (optional; if unset, defaults to runtime `openclaw_<agentId>`, otherwise `openclaw-user`)
- `MEMOS_CONVERSATION_ID` (optional override)
- `MEMOS_RECALL_GLOBAL` (default: `true`; when true, search does **not** pass conversation_id)
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX` (optional)
- `MEMOS_CONVERSATION_SUFFIX_MODE` (`none` | `counter`, default: `none`)
- `MEMOS_CONVERSATION_RESET_ON_NEW` (default: `true`, requires hooks.internal.enabled)
- `MEMORY_ENABLED` (default: `true`)
- `MEMORY_TOP_K` (default: `5`)
- `MEMORY_BUDGET_TOKENS` (default: `800`, caps injected memory context size)
- `MEMORY_SEARCH_TIMEOUT_MS` (default: `1000`)
- `MEMORY_WRITE_ASYNC` (default: `true`)
- `MEMORY_WRITE_RETRY` (default: `2`)
- `MEMORY_CACHE_TTL_SEC` (default: `60`)
- `MEMORY_SCOPE_MODE` (`user` | `chat` | `hybrid`, default: `hybrid`)
- `MEMORY_PII_FILTER_ENABLED` (default: `true`, reserved switch for filtering pipeline)
- `MEMORY_DEGRADE_ON_ERROR` (default: `true`)
- `MEMORY_GRAY_PERCENT` (default: `100`, stable rollout percentage in `0-100`)

## Optional Plugin Config
In `plugins.entries.memos-cloud-openclaw-plugin.config`:
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
  "knowledgebaseIds": [],
  "memoryLimitNumber": 6,
  "preferenceLimitNumber": 6,
  "includePreference": true,
  "includeToolMemory": false,
  "toolMemoryLimitNumber": 6,
  "relativity": 0.45,
  "tags": ["openclaw"],
  "asyncMode": true
}
```

## How it Works
- **Recall** (`before_agent_start`)
  - Builds a `/product/search` request using `user_id`, `query` (= prompt + optional prefix), and scope-aware `session_id`.
  - `session_id` is derived from `tenantId + channel + scope` based on `MEMORY_SCOPE_MODE`.
  - Formats a MemOS prompt (Role/System/Memory/Skill/Protocols) from `/product/search` results, then injects via `prependContext`.
  - Injection size is bounded by `MEMORY_BUDGET_TOKENS`, with short-lived cache via `MEMORY_CACHE_TTL_SEC`.

- **Add** (`agent_end`)
  - Builds a `/product/add` request with the **last turn** by default (user + assistant).
  - Sends `messages` with `user_id`, `session_id`, optional `custom_tags/info/writable_cube_ids`, and `async_mode`.

## Notes
- `session_id` defaults to `tenantId + channel + scope` (unless overridden by `conversationId` settings).
- Optional **prefix/suffix** via env or config; `conversationSuffixMode=counter` increments on `/new` (requires `hooks.internal.enabled`).
- If MemOS fails and `MEMORY_DEGRADE_ON_ERROR=true`, the plugin degrades gracefully and does not block the main reply path.
- Stable gray rollout is supported: hashing by `scope_key`; `MEMORY_GRAY_PERCENT=10` enables memory enhancement for about 10% of contexts.

## Acknowledgements
- Thanks to @anatolykoptev (Contributor) — LinkedIn: https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
