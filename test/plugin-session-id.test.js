import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";

function createApi(pluginConfig = {}) {
  const listeners = new Map();
  return {
    pluginConfig,
    logger: {
      info: () => {},
      warn: () => {},
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
  };
}

test("plugin uses consistent session_id for search and add when conversationId is set", async () => {
  const api = createApi({
    apiKey: "token-123",
    conversationId: "conv-fixed",
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
      { sessionKey: "s-1", sessionId: "sid-1" },
    );
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
        ],
      },
      { sessionKey: "s-1", sessionId: "sid-1" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].session_id, "conv-fixed");
  assert.equal(calls[1].session_id, "conv-fixed");
});
