import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientOpenClawHookError,
  OpenClawHookHttpError,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
} from "../../dist/repair/openclaw-hook.js";

const config = {
  hookUrl: "https://claw.example/hooks/agent",
  token: "secret",
  agentId: "clawsweeper",
  channel: "discord",
  discordTarget: "channel:123",
  thinking: "low",
  timeoutSeconds: 1,
  retryAttempts: 3,
};

const post = {
  name: "GitHub activity",
  message: "hello",
  idempotencyKey: "github-activity:test",
  deliver: false,
};

test("postOpenClawAgentHook retries transient hook failures with the same idempotency key", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (calls.length === 1) return new Response("bad gateway", { status: 502 });
    if (calls.length === 2) throw new Error("read ECONNRESET");
    return new Response(JSON.stringify({ runId: "run-123" }), { status: 200 });
  };

  const result = await postOpenClawAgentHook({
    config,
    fetcher,
    post,
    retryDelaysMs: [0, 0],
  });

  assert.equal(result.runId, "run-123");
  assert.deepEqual(calls, ["github-activity:test", "github-activity:test", "github-activity:test"]);
});

test("postOpenClawAgentHook does not retry non-transient hook failures", async () => {
  let calls = 0;
  await assert.rejects(
    postOpenClawAgentHook({
      config,
      fetcher: async () => {
        calls += 1;
        return new Response("denied", { status: 401 });
      },
      post,
      retryDelaysMs: [0, 0],
    }),
    /OpenClaw hook returned 401/,
  );
  assert.equal(calls, 1);
});

test("resolveOpenClawHookConfig supports explicit retry attempts", () => {
  assert.equal(
    resolveOpenClawHookConfig({
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "5",
    })?.retryAttempts,
    5,
  );
});

test("isTransientOpenClawHookError classifies retryable HTTP statuses and socket failures", () => {
  assert.equal(isTransientOpenClawHookError(new OpenClawHookHttpError(502, "bad")), true);
  assert.equal(isTransientOpenClawHookError(new OpenClawHookHttpError(401, "bad")), false);
  assert.equal(isTransientOpenClawHookError(new Error("read ECONNRESET")), true);
});
