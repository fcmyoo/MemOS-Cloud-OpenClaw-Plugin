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

test("plugin omits session_id for recall when recallGlobal is true", async () => {
  const api = createApi({
    apiKey: "token-123",
    recallGlobal: true,
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
  assert.equal(Object.hasOwn(calls[0], "session_id"), false);
  assert.equal(calls[1].session_id, "s-1");
});

test("plugin derives default user_id from runtime agentId", async () => {
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
      { sessionKey: "s-agent", sessionId: "sid-agent", agentId: "finance" },
    );
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-agent" },
          { role: "assistant", content: "a-agent" },
        ],
      },
      { sessionKey: "s-agent", sessionId: "sid-agent", agentId: "finance" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].user_id, "openclaw_finance");
  assert.equal(calls[1].user_id, "openclaw_finance");
  assert.equal(calls[1].info.user_id, "openclaw_finance");
});

test("plugin keeps configured user_id instead of overriding with agentId", async () => {
  const api = createApi({
    apiKey: "token-123",
    userId: "custom-user",
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
      { prompt: "hello custom user" },
      { sessionKey: "s-custom", sessionId: "sid-custom", agentId: "finance" },
    );
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-custom" },
          { role: "assistant", content: "a-custom" },
        ],
      },
      { sessionKey: "s-custom", sessionId: "sid-custom", agentId: "finance" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].user_id, "custom-user");
  assert.equal(calls[1].user_id, "custom-user");
  assert.equal(calls[1].info.user_id, "custom-user");
});

test("plugin throttles add per scope instead of globally", async () => {
  const api = createApi({
    apiKey: "token-123",
    throttleMs: 1000,
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
      json: async () => ({ code: 200, message: "ok", data: {} }),
    };
  };

  try {
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-1" },
          { role: "assistant", content: "a-1" },
        ],
      },
      { sessionKey: "scope-1", sessionId: "sid-1", agentId: "finance" },
    );
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-2" },
          { role: "assistant", content: "a-2" },
        ],
      },
      { sessionKey: "scope-2", sessionId: "sid-2", agentId: "finance" },
    );
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-3" },
          { role: "assistant", content: "a-3" },
        ],
      },
      { sessionKey: "scope-1", sessionId: "sid-1", agentId: "finance" },
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].session_id, "scope-1");
  assert.equal(calls[1].session_id, "scope-2");
});
