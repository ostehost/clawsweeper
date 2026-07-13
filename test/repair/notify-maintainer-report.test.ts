import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renderMaintainerReportMessage,
  resolveDailyReportPointer,
  runMaintainerReportNotifier,
} from "../../dist/repair/notify-maintainer-report.js";
import { flushRepairActionEvents } from "../../dist/repair/repair-action-ledger.js";

const report = {
  period: { period: "day", key: "2026-05-22", title: "Daily Report 2026-05-22" },
  totals: {
    github: { commits: 271, prsMerged: 82, issueComments: 250 },
    discord: { messages: 327 },
  },
  maintainerCount: 45,
  activeMaintainers: 24,
  summary: {
    highlights: [
      "Core platform shipped runtime and UI work.",
      "Security and policy threads covered secret redaction.",
      "Integration work spanned Discord, Slack, and Telegram.",
      "This fourth item is intentionally omitted.",
    ],
  },
  maintainers: [],
};

test("resolveDailyReportPointer picks the requested daily entry", () => {
  const pointer = resolveDailyReportPointer({
    baseUrl: "https://reports.openclaw.ai/",
    date: "2026-05-21",
    index: {
      latest: {
        day: {
          period: "day",
          key: "2026-05-22",
          href: "day/2026-05-22/",
          data: "day/2026-05-22/data.json",
        },
      },
      entries: [
        {
          period: "day",
          key: "2026-05-21",
          href: "day/2026-05-21/",
          data: "day/2026-05-21/data.json",
        },
      ],
    },
  });

  assert.deepEqual(pointer, {
    date: "2026-05-21",
    reportUrl: "https://reports.openclaw.ai/day/2026-05-21/",
    dataUrl: "https://reports.openclaw.ai/day/2026-05-21/data.json",
  });
});

test("renderMaintainerReportMessage summarizes metrics, highlights, and link", () => {
  const message = renderMaintainerReportMessage({
    report,
    reportUrl: "https://reports.openclaw.ai/day/2026-05-22/",
  });

  assert.match(message, /OpenClaw maintainer report: May 22, 2026/);
  assert.match(
    message,
    /24\/45 active; 271 commits, 82 merged PRs, 250 issue\/PR comments, 327 Discord messages/,
  );
  assert.match(message, /Core platform shipped runtime and UI work/);
  assert.doesNotMatch(message, /fourth item/);
  assert.match(message, /Full report: https:\/\/reports\.openclaw\.ai\/day\/2026-05-22\//);
});

test("runMaintainerReportNotifier fetches the live report and posts the hook", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-maintainer-report-"));
  const requests: {
    url: string;
    body: Record<string, unknown> | null;
    idempotency: string | null;
  }[] = [];
  const reportFetchHeaders: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://reports.openclaw.ai/")) {
      reportFetchHeaders.push(new Headers(init?.headers).get("cf-access-client-id") ?? "");
    }
    if (url.endsWith("/index.json")) {
      return Response.json({
        latest: {
          day: {
            period: "day",
            key: "2026-05-22",
            href: "day/2026-05-22/",
            data: "day/2026-05-22/data.json",
          },
        },
        entries: [],
      });
    }
    if (url.endsWith("/day/2026-05-22/data.json")) {
      return Response.json(report);
    }
    requests.push({
      url,
      body: JSON.parse(String(init?.body)),
      idempotency: new Headers(init?.headers).get("idempotency-key"),
    });
    return Response.json({ runId: "hook-run-1" });
  };

  const summary = await runMaintainerReportNotifier(["--write-report"], {
    root,
    fetch: fetcher,
    log: () => undefined,
    now: () => new Date("2026-05-22T12:00:00.000Z"),
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      REPORTS_ACCESS_CLIENT_ID: "access-id",
      REPORTS_ACCESS_CLIENT_SECRET: "access-secret",
    },
  });

  assert.equal(summary.sent, 1);
  assert.equal(summary.date, "2026-05-22");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://claw.example/hooks/agent");
  assert.equal(requests[0]?.idempotency, "maintainer-report:2026-05-22");
  assert.equal(requests[0]?.body?.deliver, true);
  assert.deepEqual(reportFetchHeaders, ["access-id", "access-id"]);
  assert.match(
    String(requests[0]?.body?.message),
    /Full report: https:\/\/reports\.openclaw\.ai\/day\/2026-05-22\//,
  );

  const notification = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/maintainer-report-discord.json"), "utf8"),
  );
  assert.equal(notification.hook_run_id, "hook-run-1");
  assert.equal(notification.report_url, "https://reports.openclaw.ai/day/2026-05-22/");
});

test("runMaintainerReportNotifier supports dry-run and strict missing config", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/index.json")) {
      return Response.json({
        latest: {
          day: {
            period: "day",
            key: "2026-05-22",
            href: "day/2026-05-22/",
            data: "day/2026-05-22/data.json",
          },
        },
      });
    }
    return Response.json(report);
  };

  const dryRun = await runMaintainerReportNotifier(["--dry-run"], {
    fetch: fetcher,
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });
  assert.equal(dryRun.sent, 1);

  const missingConfig = await runMaintainerReportNotifier(["--strict"], {
    fetch: fetcher,
    log: () => undefined,
    env: {},
  });
  assert.equal(missingConfig.status, "skipped");
  assert.equal(missingConfig.exitCode, 1);
});

test("missing reports still emit a durable skipped notification receipt", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-maintainer-missing-")),
  );
  const outputRoot = path.join(root, "ledger-output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_ACTION: "notify",
    GITHUB_JOB: "maintainer-notification",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "6262",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "maintainer report notification",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/maintainer-report-discord.yml@refs/heads/main",
  });

  try {
    const summary = await runMaintainerReportNotifier(["--strict", "--date", "2026-07-11"], {
      root,
      fetch: async () => Response.json({ latest: {}, entries: [] }),
      log: () => undefined,
      env: process.env,
    });
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.reason, "daily report not found");

    await flushRepairActionEvents();
    const events = fs
      .readdirSync(outputRoot, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".jsonl"))
      .flatMap((entry) =>
        fs
          .readFileSync(path.join(outputRoot, entry), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, "notification.skipped");
    assert.equal(events[0]?.action.status, "skipped");
    assert.equal(events[0]?.subject.kind, "notification");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

for (const scenario of [
  {
    name: "index fetch",
    fetch: async () => {
      throw new Error("report index unavailable");
    },
  },
  {
    name: "report parse",
    fetch: async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/index.json")) {
        return Response.json({
          latest: {
            day: {
              period: "day",
              key: "2026-07-11",
              href: "day/2026-07-11/",
              data: "day/2026-07-11/data.json",
            },
          },
          entries: [
            {
              period: "day",
              key: "2026-07-11",
              href: "day/2026-07-11/",
              data: "day/2026-07-11/data.json",
            },
          ],
        });
      }
      return new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  },
] as const) {
  test(`${scenario.name} failures emit durable non-mutation receipts`, async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-maintainer-preflight-")),
    );
    const outputRoot = path.join(root, "ledger-output");
    fs.mkdirSync(outputRoot);
    const previous = { ...process.env };
    Object.assign(process.env, {
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
      CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
      GITHUB_ACTION: "notify",
      GITHUB_JOB: "maintainer-notification",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "6363",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW: "maintainer report notification",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/maintainer-report-discord.yml@refs/heads/main",
    });

    try {
      await assert.rejects(
        runMaintainerReportNotifier(["--strict", "--date", "2026-07-11"], {
          root,
          fetch: scenario.fetch as typeof fetch,
          log: () => undefined,
          env: process.env,
        }),
      );

      await flushRepairActionEvents();
      const events = fs
        .readdirSync(outputRoot, { recursive: true, encoding: "utf8" })
        .filter((entry) => entry.endsWith(".jsonl"))
        .flatMap((entry) =>
          fs
            .readFileSync(path.join(outputRoot, entry), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.event_type, "notification.failed");
      assert.equal(events[0]?.action.status, "failed");
      assert.equal(events[0]?.action.mutation, false);
      assert.equal(events[0]?.action.retryable, true);
      assert.equal(events[0]?.attributes?.completion_reason, "preflight_failed");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
}
