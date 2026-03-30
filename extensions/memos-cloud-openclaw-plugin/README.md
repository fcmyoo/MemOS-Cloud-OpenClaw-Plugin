# MemOS Cloud OpenClaw Plugin (Lifecycle)

Official plugin maintained by MemTensor.

An Edge-First OpenClaw lifecycle plugin that uses a local **LanceDB** database to **recall** memories instantly before each run, and **adds** new messages to the local database synchronously while backing them up to MemOS Cloud asynchronously.

## Features
- **Local-First Architecture**: Ultra-low latency via local vector database, with cloud acting as an asynchronous cold backup.
- **Recall**: `before_agent_start` → Local LanceDB Search → (Optional Fallback) `/search/memory`
- **Add**: `agent_end` → Local LanceDB Add (Sync) + `/add/message` (Async Backup)
- Uses **Token** auth (`Authorization: Token <MEMOS_API_KEY>`) for cloud sync.

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
- `MEMOS_BASE_URL` (default: `https://memos.memtensor.cn/api/openmem/v1`)
- `MEMOS_API_KEY` (required; Token auth) — get it at https://memos-dashboard.openmem.net/cn/apikeys/
- `MEMOS_USER_ID` (optional; default: `openclaw-user`)
- `MEMOS_CONVERSATION_ID` (optional override)
- `MEMOS_RECALL_GLOBAL` (default: `true`; when true, search does **not** pass conversation_id)
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX` (optional)
- `MEMOS_CONVERSATION_SUFFIX_MODE` (`none` | `counter`, default: `none`)
- `MEMOS_CONVERSATION_RESET_ON_NEW` (default: `true`, requires hooks.internal.enabled)

## Optional Plugin Config
In `plugins.entries.memos-cloud-openclaw-plugin.config`:
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
  "knowledgebaseIds": [],
  "memoryLimitNumber": 6,
  "preferenceLimitNumber": 6,
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

## How it Works
- **Recall** (`before_agent_start`)
  - **Local Circuit Breaker**: First searches the local LanceDB using Hybrid Search (Vector + FTS). If the top score is adequate, it immediately injects the memory text without any network call.
  - **Cloud Fallback**: Only if the local database yields no or weak results, and `fallbackToCloud` is true, it queries `/search/memory` remotely as a backup.

- **Add** (`agent_end`)
  - **Synchronous Disk Write**: Embeds the chat text and synchronous writes vectors into the local LanceDB to guarantee instant access for the next query.
  - **Asynchronous Cloud Sync**: Triggers a detached `/add/message` request to the remote MemOS server, serving as network-agnostic persistence (`syncToCloud=true` by default).

## Notes
- `conversation_id` defaults to OpenClaw `sessionKey` (unless `conversationId` is provided). **TODO**: consider binding to OpenClaw `sessionId` directly.
- Optional **prefix/suffix** via env or config; `conversationSuffixMode=counter` increments on `/new` (requires `hooks.internal.enabled`).

## Acknowledgements
- Thanks to @anatolykoptev (Contributor) — LinkedIn: https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
