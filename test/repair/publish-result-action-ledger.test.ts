import assert from "node:assert/strict";
import test from "node:test";

import { reviewedResultRevision } from "../../dist/repair/publish-result-source.js";

test("published repair receipts use the reviewed target revision, never the workflow head", () => {
  assert.equal(
    reviewedResultRevision(
      {
        reviewed_sha: "b".repeat(40),
        head_sha: "c".repeat(40),
      },
      null,
    ),
    "b".repeat(40),
  );
  assert.equal(
    reviewedResultRevision(
      {
        canonical: { pull_request: { head_sha: "d".repeat(40) } },
      },
      null,
    ),
    "d".repeat(40),
  );
  assert.equal(reviewedResultRevision({}, null), null);
});
