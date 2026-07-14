import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LIVE_WORKERS,
  activeRepairWorkflowRunForJob,
  activeRepairWorkflowRunForJobAfterDispatchRecheck,
  fetchRecentWorkflowRuns,
  listActiveWorkflowRuns,
  normalizeWorkflowRun,
  parseRepairRunTitle,
  readMaxLiveWorkers,
  repairRunNameForJob,
  repairRunNamePrefixForJob,
} from "../../dist/repair/live-worker-capacity.js";

test("live worker capacity refuses limits above the global Codex cap", () => {
  assert.equal(MAX_LIVE_WORKERS, 128);
  assert.equal(readMaxLiveWorkers(), 51);
  assert.equal(readMaxLiveWorkers({ "max-live-workers": "1" }), 1);
  assert.equal(readMaxLiveWorkers({ "max-live-workers": "127" }), 127);
  assert.throws(
    () => readMaxLiveWorkers({ "max-live-workers": "129" }),
    /max-live-workers must be <= 128/,
  );
});

test("live worker capacity accepts env default within the global Codex cap", () => {
  const previous = process.env.CLAWSWEEPER_MAX_LIVE_WORKERS;
  process.env.CLAWSWEEPER_MAX_LIVE_WORKERS = "1";
  try {
    assert.equal(readMaxLiveWorkers(), 1);
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_MAX_LIVE_WORKERS;
    else process.env.CLAWSWEEPER_MAX_LIVE_WORKERS = previous;
  }
});

test("repair run names match workflow dispatch titles", () => {
  const issueJob = "jobs/openclaw/inbox/issue-openclaw-openclaw-75364.md";
  assert.equal(repairRunNamePrefixForJob(issueJob), "issue implementation ");
  assert.equal(repairRunNameForJob(issueJob), `issue implementation ${issueJob}`);
  assert.equal(
    repairRunNameForJob(issueJob, "automerge repair ", "router-issue123"),
    `issue implementation ${issueJob} [router-issue123]`,
  );
  assert.equal(
    repairRunNameForJob("jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md"),
    "automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
  );
  assert.equal(repairRunNamePrefixForJob("jobs/openclaw/inbox/cluster-abc.md"), "repair cluster ");
  assert.equal(
    repairRunNameForJob("jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md", "auto "),
    "auto jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
  );
  assert.deepEqual(
    parseRepairRunTitle("auto jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md", "auto "),
    {
      jobPath: "jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
      dispatchKey: null,
      jobSha256: null,
    },
  );
  assert.equal(
    repairRunNameForJob(
      "jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
      "automerge repair",
    ),
    "automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md",
  );
});

test("repair run names include command receipt keys without hiding active jobs", () => {
  const job = "jobs/openclaw/inbox/automerge-openclaw-openclaw-75363.md";
  assert.equal(
    repairRunNameForJob(job, "automerge repair ", "router-abc123"),
    `automerge repair ${job} [router-abc123]`,
  );
  assert.equal(
    activeRepairWorkflowRunForJob({
      jobPath: job,
      activeRunsByPrefix: new Map([
        [
          "automerge repair ",
          [{ displayTitle: `automerge repair ${job} [router-abc123]`, status: "in_progress" }],
        ],
      ]),
    })?.status,
    "in_progress",
  );
});

test("custom repair run prefixes normalize for formatting, parsing, and active lookup", () => {
  const job = "jobs/openclaw/inbox/automerge-openclaw-clawsweeper-521.md";
  const digest = "a".repeat(64);
  const title = repairRunNameForJob(job, "custom repair", "router-pr521", digest);
  const activeRunsByPrefix = new Map();

  assert.equal(title, `custom repair ${job} [router-pr521] (${digest})`);
  assert.deepEqual(parseRepairRunTitle(title, "custom repair"), {
    jobPath: job,
    dispatchKey: "router-pr521",
    jobSha256: digest,
  });
  assert.equal(parseRepairRunTitle(`custom repair${job}`, "custom repair"), null);
  assert.equal(parseRepairRunTitle(`custom repair  ${job}`, "custom repair"), null);
  assert.equal(
    activeRepairWorkflowRunForJob({
      jobPath: job,
      jobSha256: digest,
      automergeRunNamePrefix: "custom repair",
      activeRunsByPrefix,
      fetchWorkflowRuns: () => [
        {
          id: 521,
          status: "in_progress",
          display_title: title,
        },
      ],
    })?.databaseId,
    521,
  );
  assert.deepEqual([...activeRunsByPrefix.keys()], ["custom repair "]);
});

test("overlapping custom prefixes cannot shadow valid built-in repair titles", () => {
  const job = "jobs/openclaw/inbox/cluster-overlap.md";
  const digest = "c".repeat(64);
  const title = `repair cluster ${job} [router-overlap] (${digest})`;

  assert.deepEqual(parseRepairRunTitle(title, "repair"), {
    jobPath: job,
    dispatchKey: "router-overlap",
    jobSha256: digest,
  });
});

test("repair run titles preserve immutable job generations", () => {
  const job = "jobs/openclaw/inbox/cluster-001.md";
  const oldDigest = "a".repeat(64);
  const newDigest = "b".repeat(64);
  const keyedTitle = repairRunNameForJob(job, "automerge repair ", "router-abc123", newDigest);
  assert.equal(keyedTitle, `repair cluster ${job} [router-abc123] (${newDigest})`);
  assert.deepEqual(parseRepairRunTitle(keyedTitle), {
    jobPath: job,
    dispatchKey: "router-abc123",
    jobSha256: newDigest,
  });
  assert.deepEqual(parseRepairRunTitle(`repair cluster ${job} (${newDigest})`), {
    jobPath: job,
    dispatchKey: null,
    jobSha256: newDigest,
  });
  assert.equal(parseRepairRunTitle(`repair cluster ${job} (not-a-digest)`), null);

  const activeRunsByPrefix = new Map([
    [
      "repair cluster ",
      [
        {
          databaseId: 1,
          displayTitle: `repair cluster ${job} (${oldDigest})`,
          status: "in_progress",
        },
      ],
    ],
  ]);
  assert.equal(
    activeRepairWorkflowRunForJob({
      jobPath: job,
      jobSha256: newDigest,
      activeRunsByPrefix,
    }),
    null,
  );
  assert.equal(
    activeRepairWorkflowRunForJob({
      jobPath: job,
      jobSha256: oldDigest,
      activeRunsByPrefix,
    })?.databaseId,
    1,
  );
});

test("active legacy repair titles block immutable redispatch during rollout", () => {
  const job = "jobs/openclaw/inbox/cluster-legacy.md";
  const activeRunsByPrefix = new Map([
    [
      "repair cluster ",
      [
        {
          databaseId: 9,
          displayTitle: `repair cluster ${job}`,
          status: "in_progress",
        },
      ],
    ],
  ]);

  assert.equal(
    activeRepairWorkflowRunForJob({
      jobPath: job,
      jobSha256: "a".repeat(64),
      activeRunsByPrefix,
    })?.databaseId,
    9,
  );
});

test("workflow run normalization prefers the human Actions URL", () => {
  const run = normalizeWorkflowRun(
    {
      id: 123,
      status: "queued",
      url: "https://api.github.com/repos/openclaw/clawsweeper/actions/runs/123",
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/123",
      display_title: "automerge repair jobs/openclaw/inbox/a.md",
    },
    "queued",
  );
  assert.equal(run.url, "https://github.com/openclaw/clawsweeper/actions/runs/123");
  assert.equal(run.updatedAt, null);
});

test("active workflow run fetch paginates beyond the first 100 runs", () => {
  const calls = [];
  const runs = fetchRecentWorkflowRuns({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster.yml",
    fetchPage: (args) => {
      const path = args[3];
      const query = new URL(`https://github.test/${path}`).searchParams;
      const status = query.get("status");
      const page = Number(query.get("page"));
      calls.push({ status, page });
      if (status !== "in_progress") return [];
      if (page === 1) {
        return Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          status,
        }));
      }
      if (page === 2) {
        return Array.from({ length: 40 }, (_, index) => ({
          id: index + 101,
          status,
        }));
      }
      return [];
    },
  });

  assert.equal(runs.length, 140);
  assert.deepEqual(
    calls.filter((call) => call.status === "in_progress"),
    [
      { status: "in_progress", page: 1 },
      { status: "in_progress", page: 2 },
    ],
  );
  assert.equal(
    calls.filter((call) => call.status !== "in_progress").every((call) => call.page === 1),
    true,
  );
});

test("active workflow runs are filtered from one recent-runs fetch", () => {
  const calls = [];
  const runs = listActiveWorkflowRuns({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster.yml",
    runNamePrefix: "repair cluster ",
    excludeRunNamePrefix: "repair cluster skip",
    nowMs: Date.parse("2026-05-05T00:06:00.000Z"),
    fetchWorkflowRuns: ({ repo, workflow }) => {
      calls.push({ repo, workflow });
      return [
        {
          id: 1,
          status: "completed",
          display_title: "repair cluster completed",
          created_at: "2026-05-05T00:04:00.000Z",
        },
        {
          id: 2,
          status: "queued",
          display_title: "repair cluster older.md",
          created_at: "2026-05-05T00:01:00.000Z",
        },
        {
          id: 3,
          status: "in_progress",
          display_title: "repair cluster newer.md",
          created_at: "2026-05-05T00:03:00.000Z",
        },
        {
          id: 4,
          status: "waiting",
          display_title: "repair cluster skip this.md",
          created_at: "2026-05-05T00:05:00.000Z",
        },
        {
          id: 5,
          status: "requested",
          display_title: "automerge repair jobs/openclaw/inbox/pr.md",
          created_at: "2026-05-05T00:02:00.000Z",
        },
      ];
    },
  });

  assert.deepEqual(calls, [{ repo: "openclaw/clawsweeper", workflow: "repair-cluster.yml" }]);
  assert.deepEqual(
    runs.map((run) => run.databaseId),
    [3, 2],
  );
});

test("stale queued workflow runs do not consume repair capacity", () => {
  const runs = listActiveWorkflowRuns({
    nowMs: Date.parse("2026-05-05T08:00:00.000Z"),
    staleQueuedMs: 60 * 60 * 1000,
    fetchWorkflowRuns: () => [
      {
        id: 1,
        status: "queued",
        display_title: "repair cluster stale queued.md",
        created_at: "2026-05-05T00:00:00.000Z",
        updated_at: "2026-05-05T00:00:00.000Z",
      },
      {
        id: 2,
        status: "waiting",
        display_title: "repair cluster fresh waiting.md",
        created_at: "2026-05-05T07:30:00.000Z",
      },
      {
        id: 3,
        status: "in_progress",
        display_title: "repair cluster old but running.md",
        created_at: "2026-05-04T00:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(
    runs.map((run) => run.databaseId),
    [2, 3],
  );
});

test("active repair run recheck drops a worker that just completed", () => {
  let calls = 0;
  const active = activeRepairWorkflowRunForJobAfterDispatchRecheck({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster-worker.yml",
    jobPath: "jobs/openclaw/inbox/issue-openclaw-clawsweeper-225.md",
    recheckMs: 1,
    recheckActive: true,
    env: { GH_TOKEN: "central-token" },
    fetchWorkflowRuns: ({ env }) => {
      calls += 1;
      assert.equal(env.GH_TOKEN, "central-token");
      return calls === 1
        ? [
            {
              id: 27341186628,
              status: "in_progress",
              display_title: "repair cluster jobs/openclaw/inbox/issue-openclaw-clawsweeper-225.md",
            },
          ]
        : [];
    },
  });

  assert.equal(active, null);
  assert.equal(calls, 2);
});

test("active repair run skips the delayed sample unless requested", () => {
  let calls = 0;
  const active = activeRepairWorkflowRunForJobAfterDispatchRecheck({
    jobPath: "jobs/openclaw/inbox/cluster-001.md",
    recheckMs: 1,
    fetchWorkflowRuns: () => {
      calls += 1;
      return [
        {
          id: 1,
          status: "in_progress",
          display_title: "repair cluster jobs/openclaw/inbox/cluster-001.md",
        },
      ];
    },
  });

  assert.equal(active.databaseId, 1);
  assert.equal(calls, 1);
});
