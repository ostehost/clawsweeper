import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repairPublicationContentDigest } from "../../dist/repair/repair-action-ledger.js";
import { readText } from "../helpers.ts";

test("publish-main receipts the durable Git push only when explicitly requested", () => {
  const source = readText("src/repair/publish-main.ts");

  assert.match(source, /if \(args\.receiptKind\)/);
  assert.match(source, /runRepairMutation\(/);
  assert.match(source, /operationName: "state_publication"/);
  assert.match(
    source,
    /workKey: `state-publication:\$\{args\.receiptKind\}:\$\{publicationContentSha256\}`/,
  );
  assert.match(source, /publicationContentSha256,/);
  assert.match(source, /operation: \(\) => publishMainCommit\(publishOptions\)/);
  assert.match(source, /result === "committed" \? "accepted" : "rejected"/);
  assert.match(source, /--receipt-kind/);
});

test("publication identity binds deterministic selected content before mutation", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publication-identity-")));
  const nested = path.join(root, "records", "openclaw");
  fs.mkdirSync(nested, { recursive: true });
  const first = path.join(nested, "first.json");
  const second = path.join(nested, "second.json");
  fs.writeFileSync(first, '{"state":"ready"}\n');
  fs.writeFileSync(second, '{"state":"waiting"}\n');

  try {
    const initial = repairPublicationContentDigest(["records", "records"], root);
    assert.equal(initial, repairPublicationContentDigest(["records"], root));
    assert.equal(
      repairPublicationContentDigest(
        ["records/openclaw/second.json", "records/openclaw/first.json"],
        root,
      ),
      repairPublicationContentDigest(
        ["records/openclaw/first.json", "records/openclaw/second.json"],
        root,
      ),
    );

    fs.utimesSync(first, new Date(1_000), new Date(2_000));
    assert.equal(repairPublicationContentDigest(["records"], root), initial);

    fs.writeFileSync(second, '{"state":"complete"}\n');
    const changedBytes = repairPublicationContentDigest(["records"], root);
    assert.notEqual(changedBytes, initial);

    if (process.platform !== "win32") {
      fs.chmodSync(first, 0o755);
      assert.notEqual(repairPublicationContentDigest(["records"], root), changedBytes);
    }

    fs.rmSync(second);
    assert.notEqual(repairPublicationContentDigest(["records"], root), changedBytes);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
