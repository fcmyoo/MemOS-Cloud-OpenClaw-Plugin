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

async function withFetchStub(run) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body ?? "{}");
    calls.push({ url, headers: init.headers ?? {}, body });
    return {
      ok: true,
      json: async () => ({
        code: 200,
        message: "ok",
        data: {
          data: {
            memory_detail_list: [{ memory_value: "remembered fact", relativity: 0.9 }],
            preference_detail_list: [{ preference: "reply concisely", relativity: 0.8 }],
          },
        },
      }),
    };
  };

  try {
    await run(calls);
  } finally {
    global.fetch = originalFetch;
  }

  return calls;
}

async function verifyRecallAndAdd() {
  const api = createApi({
    apiKey: "smoke-token",
    baseUrl: "https://smoke.local",
    recallGlobal: true,
    memoryGrayPercent: 100,
  });
  plugin.register(api);

  const calls = await withFetchStub(async (items) => {
    const recallResult = await api.listeners.get("before_agent_start")?.(
      { prompt: "hello memory" },
      { sessionKey: "smoke-session", sessionId: "smoke-session-id", agentId: "finance" },
    );
    assert.ok(recallResult?.prependContext?.includes("<recall>"));

    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "hello memory" },
          { role: "assistant", content: "hi" },
        ],
      },
      { sessionKey: "smoke-session", sessionId: "smoke-session-id", agentId: "finance" },
    );

    assert.equal(items.length, 2);
  });

  const recallCall = calls[0];
  const addCall = calls[1];

  assert.equal(recallCall.url, "https://smoke.local/product/search");
  assert.equal(recallCall.headers.Authorization, "smoke-token");
  assert.equal(recallCall.body.user_id, "openclaw_finance");
  assert.equal(Object.hasOwn(recallCall.body, "session_id"), false);

  assert.equal(addCall.url, "https://smoke.local/product/add");
  assert.equal(addCall.headers.Authorization, "smoke-token");
  assert.equal(addCall.body.user_id, "openclaw_finance");
  assert.equal(addCall.body.session_id, "smoke-session");
  assert.equal(addCall.body.info.user_id, "openclaw_finance");
}

async function verifyConfiguredUserIdWins() {
  const api = createApi({
    apiKey: "smoke-token",
    baseUrl: "https://smoke.local",
    userId: "custom-user",
    recallGlobal: false,
    memoryGrayPercent: 100,
  });
  plugin.register(api);

  const calls = await withFetchStub(async () => {
    await api.listeners.get("before_agent_start")?.(
      { prompt: "configured user id" },
      { sessionKey: "custom-session", sessionId: "custom-session-id", agentId: "finance" },
    );
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.user_id, "custom-user");
  assert.equal(calls[0].body.session_id, "custom-session");
}

async function verifyScopedThrottle() {
  const api = createApi({
    apiKey: "smoke-token",
    baseUrl: "https://smoke.local",
    throttleMs: 1000,
    memoryGrayPercent: 100,
  });
  plugin.register(api);

  const calls = await withFetchStub(async () => {
    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-1" },
          { role: "assistant", content: "a-1" },
        ],
      },
      { sessionKey: "scope-a", sessionId: "sid-a", agentId: "finance" },
    );

    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-2" },
          { role: "assistant", content: "a-2" },
        ],
      },
      { sessionKey: "scope-b", sessionId: "sid-b", agentId: "finance" },
    );

    await api.listeners.get("agent_end")?.(
      {
        success: true,
        messages: [
          { role: "user", content: "q-3" },
          { role: "assistant", content: "a-3" },
        ],
      },
      { sessionKey: "scope-a", sessionId: "sid-a", agentId: "finance" },
    );
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.session_id, "scope-a");
  assert.equal(calls[1].body.session_id, "scope-b");
}

async function main() {
  await verifyRecallAndAdd();
  await verifyConfiguredUserIdWins();
  await verifyScopedThrottle();

  console.log("smoke-plugin: ok");
  console.log("- recall uses /product/search and Authorization header");
  console.log("- recallGlobal=true omits session_id");
  console.log("- runtime agentId derives user_id as openclaw_<agentId>");
  console.log("- configured userId remains authoritative");
  console.log("- add throttle is scoped, not global");
}

main().catch((error) => {
  console.error("smoke-plugin: failed");
  console.error(error);
  process.exitCode = 1;
});
