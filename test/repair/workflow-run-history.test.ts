import assert from "node:assert/strict";
import test from "node:test";

import { fetchWorkflowRunHistory } from "../../dist/repair/workflow-run-history.js";

test("workflow history paginates past the first full page", () => {
  const calls: number[] = [];
  const runs = fetchWorkflowRunHistory({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster-worker.yml",
    cutoffMs: 0,
    fetchPage: (args) => {
      const page = Number(new URL(`https://github.test/${args[3]}`).searchParams.get("page"));
      calls.push(page);
      if (page === 1) {
        return Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          display_title: `repair cluster jobs/openclaw/inbox/job-${index}.md`,
          created_at: "2026-07-13T12:00:00.000Z",
        }));
      }
      return [
        {
          id: 101,
          display_title: "repair cluster jobs/openclaw/inbox/target.md",
          created_at: "2026-07-13T11:00:00.000Z",
          html_url: "https://github.test/actions/runs/101",
        },
      ];
    },
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(runs.length, 101);
  assert.equal(runs.at(-1)?.databaseId, 101);
  assert.equal(runs.at(-1)?.displayTitle, "repair cluster jobs/openclaw/inbox/target.md");
  assert.equal(runs.at(-1)?.url, "https://github.test/actions/runs/101");
});

test("workflow history stops after crossing the requested horizon", () => {
  const calls: number[] = [];
  const runs = fetchWorkflowRunHistory({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster-worker.yml",
    cutoffMs: Date.parse("2026-07-13T10:00:00.000Z"),
    fetchPage: (args) => {
      const page = Number(new URL(`https://github.test/${args[3]}`).searchParams.get("page"));
      calls.push(page);
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        created_at: index === 99 ? "2026-07-13T09:59:59.000Z" : "2026-07-13T12:00:00.000Z",
      }));
    },
  });

  assert.deepEqual(calls, [1]);
  assert.equal(runs.length, 100);
});

test("workflow history fails closed at its pagination bound", () => {
  assert.throws(
    () =>
      fetchWorkflowRunHistory({
        repo: "openclaw/clawsweeper",
        workflow: "repair-cluster-worker.yml",
        cutoffMs: 0,
        maxPages: 2,
        fetchPage: () =>
          Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            created_at: "2026-07-13T12:00:00.000Z",
          })),
      }),
    /exceeded 200 runs/,
  );
});
