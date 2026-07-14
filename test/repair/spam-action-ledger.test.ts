import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("spam scanner records review batches, items, and durable audit logs", () => {
  const scanner = readText("src/repair/spam-scanner.ts");

  assert.match(scanner, /ACTION_EVENT_TYPES\.reviewBatch/);
  assert.match(scanner, /ACTION_EVENT_TYPES\.reviewItem/);
  assert.match(scanner, /ACTION_EVENT_TYPES\.reviewLogPublication/);
  assert.match(scanner, /flushWorkflowActionEvents\(repoRoot\(\)\)/);
  assert.match(scanner, /fieldsDropped: \["body", "prompt", "response", "reasons"\]/);
  assert.match(scanner, /commentVersionSha256/);
  assert.doesNotMatch(scanner, /attributes:\s*\{[^}]*\bbody:/s);
});

test("spam workflow imports and publishes exact current-attempt review receipts", () => {
  const workflow = readText(".github/workflows/spam-scanner.yml");

  assert.match(workflow, /permissions:\n\s+actions: read/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(
    workflow,
    /repair:action-ledger -- publish-workflow \\\n\s+--expected-producer-job scan/,
  );
  assert.match(workflow, /jq -r '\.paths\[\]\?'/);
  assert.match(workflow, /cp "\$durable_event_path" "\$event_path"/);
  assert.match(workflow, /chore: append spam review action ledger/);
  assert.ok(
    workflow.indexOf("Commit spam scanner audit") <
      workflow.indexOf("Import immutable spam review action ledger"),
  );
});

test("spam workflow sparse checkout contains the action ledger runtime", () => {
  const workflow = readText(".github/workflows/spam-scanner.yml");

  for (const requiredPath of [
    "src/action-ledger-files.ts",
    "src/action-ledger-runtime.ts",
    "src/action-ledger.ts",
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${requiredPath.replaceAll(".", "\\.")}$`, "m"));
  }
});
