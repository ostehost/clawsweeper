import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { flushRepairActionEvents } from "../../dist/repair/repair-action-ledger.js";
import {
  dashboardFailureOutcome,
  isTerminalMutationState,
  isSuccessfulTerminalMutationState,
  issueImplementationStatusMarker,
  postDashboardStatus,
  recordDashboardStatus,
  renderIssueImplementationStatusComment,
} from "../../dist/repair/issue-implementation-status.js";

const options = {
  repo: "steipete/example",
  itemNumber: 42,
  state: "Planning",
  detail: "Codex is inspecting the issue and repository.",
  runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/100",
  prUrl: "",
  title: "Add compact export mode",
};

test("issue implementation status creates a stable public progress comment", () => {
  const body = renderIssueImplementationStatusComment("", options);

  assert.match(body, new RegExp(issueImplementationStatusMarker(42)));
  assert.match(body, /automatically building this issue/);
  assert.match(body, /State: Planning/);
  assert.match(body, /clawsweeper:manual-only/);
  assert.match(body, /clawsweeper:human-review/);
});

test("issue implementation status includes a generated pull request", () => {
  const body = renderIssueImplementationStatusComment("", {
    ...options,
    state: "Blocked",
    prUrl: "https://github.com/steipete/example/pull/51",
  });

  assert.match(body, /PR: https:\/\/github\.com\/steipete\/example\/pull\/51/);
});

test("blocked and failed status comments require the terminal mutation guard", () => {
  for (const state of ["Complete", "PR Opened", "Blocked", "Failed"]) {
    assert.equal(isTerminalMutationState(state), true, state);
  }
  for (const state of ["Queued", "Planning", "Building"]) {
    assert.equal(isTerminalMutationState(state), false, state);
  }
  for (const state of ["Complete", "PR Opened"]) {
    assert.equal(isSuccessfulTerminalMutationState(state), true, state);
  }
  for (const state of ["Blocked", "Failed"]) {
    assert.equal(isSuccessfulTerminalMutationState(state), false, state);
  }

  const source = fs.readFileSync("src/repair/issue-implementation-status.ts", "utf8");
  assert.match(source, /publicationReceiptSha256[\s\S]*runVerifiedPublishedPullMutation\(/);
  assert.match(source, /--sealed-source-only[\s\S]*runVerifiedSealedSourceMutation\(/);
  assert.match(
    source,
    /isSuccessfulTerminalMutationState\(state\) \|\| prUrl[\s\S]*requires a verified publication receipt/,
  );
  assert.match(source, /repairSourceRevision\(job\?\.frontmatter \?\? \{\}\)/);
  assert.doesNotMatch(source, /sourceRevision: String\(process\.env\.GITHUB_SHA/);
});

test("issue implementation status updates progress without replacing worker results", () => {
  const initial = renderIssueImplementationStatusComment("", options);
  const withResult = `${initial}\n\n## Implementation result\n\nPull request opened.`;
  const updated = renderIssueImplementationStatusComment(withResult, {
    ...options,
    state: "Complete",
    detail: "Implementation workflow completed.",
  });

  assert.doesNotMatch(updated, /Automatic implementation progress:/);
  assert.match(updated, /Automatic implementation completed\./);
  assert.doesNotMatch(updated, /## Implementation result/);
});

test("issue implementation status collapses an opened PR to a concise terminal comment", () => {
  const body = renderIssueImplementationStatusComment("", {
    ...options,
    state: "PR Opened",
    detail: "Checks continue on the pull request.",
    prUrl: "https://github.com/steipete/example/pull/51",
  });

  assert.match(
    body,
    /Implementation PR opened: https:\/\/github\.com\/steipete\/example\/pull\/51/,
  );
  assert.match(body, /Status: Checks continue on the pull request\./);
  assert.doesNotMatch(body, /Automatic implementation progress|Opt out|State:/);
});

test("issue build workflow reports an opened PR without calling pending CI blocked", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

  assert.match(workflow, /state="PR Opened"/);
  assert.match(workflow, /TRUSTED_PR_URL: \$\{\{ steps\.publish\.outputs\.target_pr_url \}\}/);
  assert.match(
    workflow,
    /POST_FLIGHT_OUTCOME: \$\{\{ steps\.post_flight\.outputs\.report_outcome \}\}/,
  );
  assert.doesNotMatch(workflow, /POST_FLIGHT_OUTCOME: \$\{\{ steps\.post_flight\.outcome \}\}/);
  assert.match(
    workflow,
    /steps\.post_flight\.outputs\.report_outcome == 'success'[\s\S]*completion-reason gates_passed/,
  );
  assert.match(
    workflow,
    /name: Post-flight finalize fix PRs[\s\S]*continue-on-error: true[\s\S]*name: Fail incomplete post-flight result/,
  );
  assert.match(
    workflow,
    /steps\.post_flight\.outcome == 'failure' \|\| steps\.post_flight\.outputs\.report_outcome != 'success'/,
  );
  assert.match(workflow, /The exact independently validated repair was published at/);
  assert.match(
    workflow,
    /status_guard=\([\s\S]*--handoff-root \.clawsweeper-repair\/execution[\s\S]*--validation-receipt-sha256 "\$\{\{ needs\.validate\.outputs\.receipt_sha256 \}\}"/,
  );
  assert.match(
    workflow,
    /if \[ -n "\$PUBLICATION_RECEIPT_SHA256" \]; then[\s\S]*--publication-receipt-sha256 "\$PUBLICATION_RECEIPT_SHA256"[\s\S]*else[\s\S]*TRUSTED_PR_URL=""[\s\S]*--sealed-source-only/,
  );
  assert.match(
    workflow,
    /\[ -n "\$TRUSTED_PR_URL" \] && \[ -n "\$PUBLICATION_RECEIPT_SHA256" \][\s\S]*state="PR Opened"/,
  );
  assert.doesNotMatch(
    workflow,
    /detail="The automatic implementation worker stopped before all post-flight gates passed:/,
  );
});

test("dashboard response loss records one unknown POST outcome", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-status-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "dashboard",
    CLAWSWEEPER_STATUS_INGEST_TOKEN: "dashboard-secret",
    CLAWSWEEPER_STATUS_INGEST_URL: "https://dashboard.example/events",
    GITHUB_ACTION: "publish_dashboard",
    GITHUB_JOB: "mutate",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "4242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  });
  let requests = 0;
  try {
    await assert.rejects(
      postDashboardStatus({ ...options, sourceRevision: "b".repeat(40) }, async () => {
        requests += 1;
        throw new Error("response lost after dashboard request");
      }),
      /response lost/,
    );
    assert.equal(requests, 1);
    await flushRepairActionEvents();
    const mutations = readEvents(outputRoot).filter(
      (event) => event.event_type === "repair.mutation",
    );
    assert.deepEqual(
      mutations.map((event) => [
        event.action.status,
        event.attributes.completion_reason,
        event.action.retryable,
      ]),
      [
        ["started", "mutation_attempted", true],
        ["failed", "mutation_outcome_unknown", true],
      ],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard identity binds the full semantic POST request", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-identity-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "dashboard-identity",
    CLAWSWEEPER_STATUS_INGEST_TOKEN: "dashboard-secret",
    CLAWSWEEPER_STATUS_INGEST_URL: "https://dashboard.example/events",
    GITHUB_ACTION: "publish_dashboard",
    GITHUB_JOB: "mutate",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "4242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  });
  const base = { ...options, sourceRevision: "b".repeat(40) };
  try {
    for (const request of [
      base,
      { ...base },
      { ...base, runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/101" },
      { ...base, prUrl: "https://github.com/steipete/example/pull/51" },
      { ...base, title: "Add compact import mode" },
      { ...base, detail: "Codex is implementing the issue." },
      { ...base, state: "Building" },
    ]) {
      assert.equal(
        await postDashboardStatus(request, async () => new Response(null, { status: 202 })),
        "sent",
      );
    }
    await flushRepairActionEvents();

    const keys = readEvents(outputRoot)
      .filter(
        (event) =>
          event.event_type === "repair.mutation" &&
          (event.action as Record<string, unknown>).status === "started",
      )
      .map((event) => event.idempotency_key_sha256);
    assert.equal(keys.length, 7);
    assert.equal(keys[0], keys[1]);
    for (const key of keys.slice(2)) assert.notEqual(key, keys[0]);
    assert.equal(new Set(keys).size, 6);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard HTTP outcomes preserve ambiguous server failures", async () => {
  for (const [status, expected] of [
    [503, ["failed", "mutation_outcome_unknown", true]],
    [422, ["skipped", "mutation_rejected", false]],
  ] as const) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dashboard-${status}-`)));
    const outputRoot = path.join(root, "output");
    fs.mkdirSync(outputRoot);
    const previous = { ...process.env };
    Object.assign(process.env, {
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `dashboard-${status}`,
      CLAWSWEEPER_STATUS_INGEST_TOKEN: "dashboard-secret",
      CLAWSWEEPER_STATUS_INGEST_URL: "https://dashboard.example/events",
      GITHUB_ACTION: "publish_dashboard",
      GITHUB_JOB: "mutate",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "4242",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW: "repair cluster worker",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
    });
    try {
      await assert.rejects(
        postDashboardStatus(
          { ...options, sourceRevision: "b".repeat(40) },
          async () => new Response("remote failure", { status }),
        ),
        new RegExp(`dashboard ingest returned ${status}`),
      );
      await flushRepairActionEvents();
      const mutations = readEvents(outputRoot).filter(
        (event) => event.event_type === "repair.mutation",
      );
      assert.deepEqual(
        mutations.map((event) => [
          event.action.status,
          event.attributes.completion_reason,
          event.action.retryable,
        ]),
        [["started", "mutation_attempted", true], expected],
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("dashboard terminal receipts preserve uncertain and rejected mutation outcomes", async () => {
  for (const [label, failure, expected] of [
    [
      "transport",
      async () => {
        throw new Error("response lost after dashboard request");
      },
      ["failed", true, "mutation_outcome_unknown", true],
    ],
    [
      "server",
      async () => new Response("remote failure", { status: 503 }),
      ["failed", true, "mutation_outcome_unknown", true],
    ],
    [
      "rejected",
      async () => new Response("invalid request", { status: 422 }),
      ["skipped", false, "mutation_rejected", false],
    ],
  ] as const) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dashboard-${label}-`)));
    const outputRoot = path.join(root, "output");
    fs.mkdirSync(outputRoot);
    const previous = { ...process.env };
    Object.assign(process.env, {
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `dashboard-terminal-${label}`,
      CLAWSWEEPER_STATUS_INGEST_TOKEN: "dashboard-secret",
      CLAWSWEEPER_STATUS_INGEST_URL: "https://dashboard.example/events",
      GITHUB_ACTION: "publish_dashboard",
      GITHUB_JOB: "mutate",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "4242",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW: "repair cluster worker",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
    });
    try {
      let failureOutcome: "rejected" | "unknown" = "unknown";
      try {
        await postDashboardStatus(
          { ...options, sourceRevision: "b".repeat(40) },
          failure as typeof fetch,
        );
      } catch (error) {
        failureOutcome = dashboardFailureOutcome(error) as "rejected" | "unknown";
      }
      recordDashboardStatus(
        { ...options, sourceRevision: "b".repeat(40) },
        "failed",
        failureOutcome,
      );
      await flushRepairActionEvents();

      const terminal = readEvents(outputRoot).find(
        (event) => event.event_type === "dashboard.lifecycle",
      );
      assert.deepEqual(
        [
          terminal?.action.status,
          terminal?.action.mutation,
          terminal?.attributes.completion_reason,
          terminal?.action.retryable,
        ],
        expected,
        label,
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function readEvents(root: string): Array<Record<string, unknown>> {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return readEvents(target);
    if (!target.endsWith(".jsonl")) return [];
    return fs
      .readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  });
}
