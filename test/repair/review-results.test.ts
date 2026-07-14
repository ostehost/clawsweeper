import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReviewedTimelineCursor } from "../../dist/repair/timeline-cursor.js";

test("repair result review binds merge actions to the exact preflight timeline", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-review-result-cursor-"));
  const cursor = createReviewedTimelineCursor([
    { id: 88001, event: "commented", body: "reviewed" },
  ]);
  try {
    writeReviewFixture(runDir, cursor, cursor);
    const matching = reviewResult(runDir);
    assert.equal(matching.status, 0, matching.stderr);
    assert.equal(JSON.parse(matching.stdout).status, "passed");

    writeReviewFixture(runDir, cursor, createReviewedTimelineCursor([]));
    const stale = reviewResult(runDir);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /target_timeline_cursor does not match preflight/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

function writeReviewFixture(runDir: string, planCursor: string, resultCursor: string): void {
  fs.writeFileSync(
    path.join(runDir, "cluster-plan.json"),
    `${JSON.stringify({
      repo: "openclaw/openclaw",
      cluster_id: "merge-openclaw-openclaw-74134",
      items: [
        {
          ref: "#74134",
          kind: "pull_request",
          state: "open",
          updated_at: "2026-04-30T00:00:00Z",
          timeline_cursor: planCursor,
          security_sensitive: false,
        },
      ],
    })}\n`,
  );
  fs.writeFileSync(
    path.join(runDir, "result.json"),
    `${JSON.stringify({
      status: "planned",
      repo: "openclaw/openclaw",
      cluster_id: "merge-openclaw-openclaw-74134",
      mode: "autonomous",
      canonical: "#74134",
      actions: [
        {
          action: "merge_candidate",
          classification: "canonical",
          target: "#74134",
          target_kind: "pull_request",
          target_updated_at: "2026-04-30T00:00:00Z",
          target_timeline_cursor: resultCursor,
          idempotency_key: "merge-openclaw-openclaw-74134",
          evidence: ["Codex review passed for the exact preflight state."],
          status: "planned",
        },
      ],
      merge_preflight: [
        {
          target: "#74134",
          security_status: "cleared",
          security_evidence: ["No security signal."],
          comments_status: "resolved",
          comments_evidence: ["No unresolved comments."],
          bot_comments_status: "resolved",
          bot_comments_evidence: ["No unresolved bot comments."],
          validation_commands: ["pnpm run check"],
          codex_review: {
            command: "/review",
            status: "passed",
            findings_addressed: true,
            evidence: ["Codex review passed."],
          },
        },
      ],
    })}\n`,
  );
}

function reviewResult(runDir: string) {
  return spawnSync(process.execPath, ["dist/repair/review-results.js", runDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}
