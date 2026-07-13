import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("repair result fallback rejects ledger-only artifacts and verifies selected result payloads", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const download = workflow.slice(
    workflow.indexOf("- name: Download worker artifacts"),
    workflow.indexOf("- name: Publish result ledger"),
  );

  assert.match(download, /final_artifact="clawsweeper-repair-\$\{RUN_ID\}-\$\{RUN_ATTEMPT:-1\}"/);
  assert.match(download, /findResultPaths\("artifacts"\)/);
  assert.match(download, /if \[ ! -s "\$result_paths_file" \]; then/);
  assert.match(download, /pnpm run repair:review-results -- "\$\{result_paths\[@\]\}"/);
  assert.doesNotMatch(download, /find artifacts -type f -print -quit/);
});

test("repair result publication rejects untrusted worker heads before minting write credentials", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const classification = workflow.slice(
    workflow.indexOf("- name: Classify trusted worker artifact contract"),
    workflow.indexOf("- name: Create GitHub App token"),
  );

  assert.match(workflow, /permissions:\n  contents: read/);
  assert.ok(
    workflow.indexOf("- name: Classify trusted worker artifact contract") <
      workflow.indexOf("- name: Create GitHub App token"),
  );
  assert.match(
    workflow,
    /uses: \.\/\.github\/actions\/setup-state[\s\S]*?token: \$\{\{ steps\.state-token\.outputs\.token \}\}[\s\S]*?fetch-depth: 0/,
  );
  assert.match(
    classification,
    /if \[\[ ! "\$WORKER_HEAD_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]; then[\s\S]*exit 1/,
  );
  assert.match(classification, /! git merge-base --is-ancestor "\$WORKER_HEAD_SHA"[\s\S]*exit 1/);
});
