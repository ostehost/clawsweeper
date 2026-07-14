import assert from "node:assert/strict";
import test from "node:test";

import {
  isMissingGithubContentError,
  missingCommitFindingReport,
} from "../../dist/repair/commit-finding-report.js";

test("commit finding intake classifies missing report blobs as skips", () => {
  assert.equal(isMissingGithubContentError("gh: Not Found (HTTP 404)"), true);
  assert.equal(isMissingGithubContentError("HTTP 503: Service Unavailable"), false);

  assert.deepEqual(
    missingCommitFindingReport("openclaw/clawsweeper", "records/openclaw-openclaw/commits/abc.md"),
    {
      ok: false,
      reason:
        "report openclaw/clawsweeper:records/openclaw-openclaw/commits/abc.md is not available on main",
    },
  );
});
