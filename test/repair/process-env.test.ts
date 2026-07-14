import assert from "node:assert/strict";
import test from "node:test";

import {
  clawsweeperGitIdentityEnv,
  clawsweeperGitUserName,
  codexModelArgs,
  repairCodexRedactValues,
  codexSubprocessEnv,
  internalCodexModel,
  repairCodexReasoningEffort,
  repairCodexServiceTier,
} from "../../dist/repair/process-env.js";

test("codexSubprocessEnv forces ClawSweeper git identity and strips tokens", () => {
  withEnv(
    {
      CLAWSWEEPER_GIT_USER_NAME: "clawsweeper-repair",
      CLAWSWEEPER_GIT_USER_EMAIL: "bot@example.invalid",
      CLAWSWEEPER_TARGET_GH_TOKEN: "secret",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GITHUB_ACTIONS: "true",
      OPENAI_API_KEY: "secret",
      CODEX_API_KEY: "secret",
      CODEX_ACCESS_TOKEN: "codex-access-secret",
      ACTIONS_RUNTIME_TOKEN: "actions-runtime-secret",
      ACTIONS_RESULTS_URL: "https://results.example.invalid/runtime",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-oidc-secret",
      GITHUB_ACTIONS_RUNTIME_TOKEN: "github-runtime-secret",
      GITHUB_ENV: "/tmp/github-env",
      GITHUB_OUTPUT: "/tmp/github-output",
      GITHUB_PATH: "/tmp/github-path",
      GITHUB_STATE: "/tmp/github-state",
      GITHUB_STEP_SUMMARY: "/tmp/github-summary",
      AMBIENT_DEPLOY_SECRET: "ambient-secret",
      CLAWSWEEPER_INTERNAL_MODEL: "secret-model",
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-secret",
      CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: "service-secret",
      CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL: "wss://example.invalid/secret",
      CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: "https://example.invalid/secret",
    },
    () => {
      const env = codexSubprocessEnv();

      assert.equal(env.GIT_AUTHOR_NAME, "clawsweeper");
      assert.equal(env.GIT_AUTHOR_EMAIL, "bot@example.invalid");
      assert.equal(env.GIT_COMMITTER_NAME, "clawsweeper");
      assert.equal(env.GIT_COMMITTER_EMAIL, "bot@example.invalid");
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_TARGET_GH_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
      assert.equal(env.ACTIONS_RUNTIME_TOKEN, undefined);
      assert.equal(env.ACTIONS_RESULTS_URL, undefined);
      assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.equal(env.GITHUB_ACTIONS_RUNTIME_TOKEN, undefined);
      assert.equal(env.GITHUB_ENV, undefined);
      assert.equal(env.GITHUB_OUTPUT, undefined);
      assert.equal(env.GITHUB_PATH, undefined);
      assert.equal(env.GITHUB_STATE, undefined);
      assert.equal(env.GITHUB_STEP_SUMMARY, undefined);
      assert.equal(env.AMBIENT_DEPLOY_SECRET, undefined);
      assert.equal(env.CLAWSWEEPER_INTERNAL_MODEL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL, undefined);
      assert.equal(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL, undefined);
      assert.equal(internalCodexModel("internal"), "secret-model");
      assert.deepEqual(codexModelArgs("internal"), []);
      assert.deepEqual(codexModelArgs("secret-model"), []);
      assert.deepEqual(codexModelArgs("explicit-public-model"), [
        "--model",
        "explicit-public-model",
      ]);
      const redactValues = repairCodexRedactValues({
        ACTIONS_RUNTIME_TOKEN: "actions-runtime-secret",
        ACTIONS_RESULTS_URL: "https://results.example.invalid/runtime",
        AMBIENT_DEPLOY_SECRET: "ambient-secret",
      });
      assert.equal(redactValues.includes("https://results.example.invalid/runtime"), true);
      assert.equal(redactValues.includes("actions-runtime-secret"), true);
      assert.equal(redactValues.includes("ambient-secret"), true);
      assert.equal(redactValues.includes("secret-model"), true);
    },
  );
});

test("codexSubprocessEnv preserves local Codex auth outside Actions", () => {
  withEnv(
    {
      GITHUB_ACTIONS: "",
      OPENAI_API_KEY: "local-openai-secret",
      CODEX_API_KEY: "local-codex-secret",
      CODEX_ACCESS_TOKEN: "local-access-secret",
      AMBIENT_DEPLOY_SECRET: "ambient-secret",
    },
    () => {
      const env = codexSubprocessEnv();

      assert.equal(env.OPENAI_API_KEY, "local-openai-secret");
      assert.equal(env.CODEX_API_KEY, "local-codex-secret");
      assert.equal(env.CODEX_ACCESS_TOKEN, "local-access-secret");
      assert.equal(env.AMBIENT_DEPLOY_SECRET, undefined);
    },
  );
});

test("clawsweeper git identity defaults to avatar-friendly bot name", () => {
  withEnv({ CLAWSWEEPER_GIT_USER_NAME: "", CLAWSWEEPER_GIT_USER_EMAIL: "" }, () => {
    assert.equal(clawsweeperGitUserName(), "clawsweeper");
    assert.deepEqual(clawsweeperGitIdentityEnv(), {
      GIT_AUTHOR_NAME: "clawsweeper",
      GIT_AUTHOR_EMAIL: "274271284+clawsweeper[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "clawsweeper",
      GIT_COMMITTER_EMAIL: "274271284+clawsweeper[bot]@users.noreply.github.com",
    });
  });
});

test("repair Codex config keeps repair workers on high fast", () => {
  assert.equal(repairCodexReasoningEffort(undefined), "high");
  assert.equal(repairCodexReasoningEffort(""), "high");
  assert.equal(repairCodexReasoningEffort("xhigh"), "high");
  assert.equal(repairCodexReasoningEffort("XHIGH"), "high");
  assert.equal(repairCodexReasoningEffort("medium"), "medium");

  assert.equal(repairCodexServiceTier(undefined), "fast");
  assert.equal(repairCodexServiceTier(""), "fast");
  assert.equal(repairCodexServiceTier("fast"), "fast");
});

function withEnv(values: Record<string, string>, callback: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  try {
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
