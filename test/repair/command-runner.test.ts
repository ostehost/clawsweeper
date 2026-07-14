import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { resolveSpawnCommand } from "../../dist/command.js";
import { runCommand } from "../../dist/repair/command-runner.js";
import { mockCommandBinEnv } from "../helpers.ts";

test("runCommand handles validation output larger than Node's sync spawn default", () => {
  const output = runCommand(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
  ]);

  assert.equal(output.length, 2 * 1024 * 1024);
});

test("runCommand reports command timeouts with the rendered command", () => {
  assert.throws(
    () =>
      runCommand(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 1000)"], {
        timeoutMs: 10,
      }),
    /command timed out after 10ms: .*node.* -e/,
  );
});

test("runCommand honors shared command bin overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-command-runner-"));
  const commandPath = join(root, "validate.js");
  writeFileSync(commandPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");

  try {
    const args = [
      "space value",
      "a&b",
      "paren(x)",
      "bang!",
      "tail\\",
      "double\\\\",
      "space tail\\",
      'quote"x',
      'quote slash\\"',
    ];
    assert.equal(
      runCommand("validate", args, {
        env: {
          ...process.env,
          ...mockCommandBinEnv("validate", commandPath),
        },
      }),
      JSON.stringify(args),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCommand does not execute checkout-local gh from a relative PATH entry", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-command-runner-"));
  const binDir = join(root, "trusted-bin");
  const marker = join(root, "captured-token");
  const checkoutGh = join(root, "gh");
  const trustedGh = join(binDir, "gh");
  try {
    mkdirSync(binDir);
    writeFileSync(checkoutGh, `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > ${JSON.stringify(marker)}\n`);
    writeFileSync(trustedGh, "#!/bin/sh\nprintf 'trusted'\n");
    chmodSync(checkoutGh, 0o755);
    chmodSync(trustedGh, 0o755);

    assert.equal(
      runCommand("gh", [], {
        cwd: root,
        env: {
          PATH: `.${delimiter}${binDir}`,
          GH_BIN: trustedGh,
          GH_TOKEN: "dummy-secret",
        },
      }),
      "trusted",
    );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared spawn resolver escapes Windows batch launcher arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-command-runner-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "validate.CMD"), "@echo off\r\n");

  try {
    const invocation = resolveSpawnCommand(
      "validate",
      ["space value", "a&b", "paren(x)", "tail\\", 'quote"x'],
      {
        cwd: root,
        env: {
          Path: binDir,
          PATHEXT: ".CMD",
          SystemRoot: String.raw`C:\Windows`,
        },
        platform: "win32",
      },
    );

    assert.match(invocation.command, /C:\\Windows[\\/]System32[\\/]cmd\.exe/);
    assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
    const shellCommand = invocation.args[3] ?? "";
    assert.match(shellCommand, /validate\.cmd/i);
    assert.match(shellCommand, /\^\^\^"space\^\^\^ value\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"a\^\^\^&b\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"paren\^\^\^\(x\^\^\^\)\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"tail\\\\\^\^\^"/);
    assert.match(shellCommand, /\^\^\^"quote\\\^\^\^"x\^\^\^"/);
    assert.equal(invocation.windowsVerbatimArguments, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected Windows commands ignore checkout-relative PATH entries", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-command-runner-"));
  const binDir = join(root, "trusted-bin");
  const trustedGh = join(binDir, "gh.CMD");
  mkdirSync(binDir);
  writeFileSync(join(root, "gh.CMD"), "@echo checkout-local\r\n");
  writeFileSync(trustedGh, "@echo trusted\r\n");

  try {
    const invocation = resolveSpawnCommand("gh", ["api", "user"], {
      cwd: root,
      env: {
        Path: `.${delimiter}${binDir}`,
        PATHEXT: ".CMD",
        SystemRoot: String.raw`C:\Windows`,
      },
      platform: "win32",
    });

    assert.match(invocation.command, /C:\\Windows[\\/]System32[\\/]cmd\.exe/);
    assert.equal(invocation.args[3]?.includes(trustedGh), true, invocation.args[3]);
    assert.equal(invocation.windowsVerbatimArguments, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
