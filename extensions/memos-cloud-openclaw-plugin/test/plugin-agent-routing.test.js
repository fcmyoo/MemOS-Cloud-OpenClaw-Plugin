import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";

function createApi(pluginConfig = {}) {
  const listeners = new Map();
  const logs = { info: [], warn: [] };
  return {
    pluginConfig,
    logger: {
      info: (line) => logs.info.push(line),
      warn: (line) => logs.warn.push(line),
    },
    config: {
      hooks: {
        internal: {
          enabled: false,
        },
      },
    },
    on(name, handler) {
      listeners.set(name, handler);
    },
    registerHook() {},
    listeners,
    logs,
  };
}

test("plugin routes recall and add by ctx.agentId at runtime", async () => {
  const api = createApi({
    apiKey: "token-123",
    recallGlobal: false,
    memoryGrayPercent: 100,
  });
  plugin.register(api);

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    calls.push(body);
    return {
      ok: true,
      json: async () => ({
        code: 200,
        message: "ok",
        data: {
          data: {
            memory_detail_list: [],
            preference_detail_list: [],
          },
        },
      }),
    };
  };

  try {
    await api.listeners.get("before_agent_start")?.(
      { prompt: "hello memory" },
      { agentId: "finance", sessionKey: "s-1", sessionId: "sid-1" },
    );
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
        ],
      },
      { agentId: "finance", sessionKey: "s-1", sessionId: "sid-1" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].user_id, "finance");
  assert.equal(calls[0].session_id, "finance:s-1");
  assert.equal(calls[1].user_id, "finance");
  assert.equal(calls[1].session_id, "finance:s-1");
  assert.deepEqual(calls[1].custom_tags, ["finance", "memos"]);
  assert.equal(calls[1].info.agent_id, "finance");
});

test("plugin falls back to ctx.sessionKey when ctx.agentId is missing", async () => {
  const api = createApi({
    apiKey: "token-123",
    recallGlobal: false,
    memoryGrayPercent: 100,
  });
  plugin.register(api);

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    calls.push(body);
    return {
      ok: true,
      json: async () => ({
        code: 200,
        message: "ok",
        data: {
          data: {
            memory_detail_list: [],
            preference_detail_list: [],
          },
        },
      }),
    };
  };

  try {
    await api.listeners.get("before_agent_start")?.(
      { prompt: "hello memory" },
      { sessionKey: "strategy-room", sessionId: "sid-1" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].user_id, "strategy-room");
  assert.equal(calls[0].session_id, "strategy-room:strategy-room");
});

test("plugin blocks non-allowed agents when allowedAgentIds is set", async () => {
  const api = createApi({
    apiKey: "token-123",
    recallGlobal: false,
    memoryGrayPercent: 100,
    allowedAgentIds: ["finance"],
  });
  plugin.register(api);

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    calls.push(JSON.parse(init?.body ?? "{}"));
    return {
      ok: true,
      json: async () => ({ code: 200, data: { data: {} } }),
    };
  };

  try {
    await api.listeners.get("before_agent_start")?.(
      { prompt: "hello memory" },
      { agentId: "dev", sessionKey: "s-1", sessionId: "sid-1" },
    );
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [{ role: "user", content: "q1" }],
      },
      { agentId: "dev", sessionKey: "s-1", sessionId: "sid-1" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 0);
});
