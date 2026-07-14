import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  handOffExactFilesToPrincipal,
  reclaimExactPrincipalFiles,
} from "../dist/trusted-principal-runtime.js";

test("exact Codex output handoff accepts one bounded regular file", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-codex-output-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const output = join(root, "result.json");
  writeFileSync(output, "", { mode: 0o600 });
  const uid = process.getuid!();
  const gid = process.getgid!();
  const files = [{ path: output, maxBytes: 64 }];
  handOffExactFilesToPrincipal({ files, hostUid: uid, principal: { uid, gid } });
  writeFileSync(output, '{"ok":true}\n');
  reclaimExactPrincipalFiles({ files, hostUid: uid, hostGid: gid, principal: { uid, gid } });
  assert.equal(readFileSync(output, "utf8"), '{"ok":true}\n');
  assert.equal(statSync(output).nlink, 1);
  assert.equal(statSync(output).mode & 0o777, 0o600);
});

test("exact Codex output handoff rejects symlinks, hard links, and oversized output", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-codex-output-reject-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const uid = process.getuid!();
  const gid = process.getgid!();
  const output = join(root, "result.json");
  const target = join(root, "target.json");
  writeFileSync(target, "");
  symlinkSync(target, output);
  assert.throws(
    () =>
      handOffExactFilesToPrincipal({
        files: [{ path: output, maxBytes: 64 }],
        hostUid: uid,
        principal: { uid, gid },
      }),
    /ELOOP|symbolic link/i,
  );
  unlinkSync(output);
  writeFileSync(output, "");
  linkSync(output, join(root, "second-link.json"));
  assert.throws(
    () =>
      handOffExactFilesToPrincipal({
        files: [{ path: output, maxBytes: 64 }],
        hostUid: uid,
        principal: { uid, gid },
      }),
    /exactly one|exact host-owned regular file/i,
  );
  unlinkSync(join(root, "second-link.json"));
  writeFileSync(output, "too large");
  assert.throws(
    () =>
      reclaimExactPrincipalFiles({
        files: [{ path: output, maxBytes: 4 }],
        hostUid: uid,
        hostGid: gid,
        principal: { uid, gid },
      }),
    /exceeds 4 bytes/,
  );
});
