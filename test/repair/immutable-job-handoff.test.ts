import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  isMissingImmutableJobError,
  resolveCurrentStateJobIdentity,
} from "../../dist/repair/immutable-job-handoff.js";

const workerWorkflowPath = ".github/workflows/repair-cluster-worker.yml";
const commitIntakeWorkflowPath = ".github/workflows/repair-commit-finding-intake.yml";
const issueIntakeWorkflowPath = ".github/workflows/repair-issue-implementation-intake.yml";
const clusterIntakeWorkflowPath = ".github/workflows/repair-cluster-intake.yml";
const createJobPath = "src/repair/create-job.ts";

test("immutable worker handoff overwrites mutable state and is rerun-stable", () => {
  const workflow = parse(fs.readFileSync(workerWorkflowPath, "utf8"));
  const checkStep = workflow.jobs.cluster.steps.find(
    (step: { name?: string }) => step.name === "Check job file",
  );
  assert.equal(typeof checkStep?.run, "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-immutable-job-"));
  const jobPath = "jobs/openclaw/inbox/issue-openclaw-openclaw-abc.md";
  const mutablePath = path.join(root, jobPath);
  const immutablePath = path.join(root, ".clawsweeper-repair", "immutable-state", jobPath);
  const outputPath = path.join(root, "output.txt");
  const immutableBytes = Buffer.from("immutable job bytes\n", "utf8");
  const digest = createHash("sha256").update(immutableBytes).digest("hex");
  fs.mkdirSync(path.dirname(mutablePath), { recursive: true });
  fs.mkdirSync(path.dirname(immutablePath), { recursive: true });
  fs.writeFileSync(mutablePath, "later mutable overwrite\n");
  fs.writeFileSync(immutablePath, immutableBytes);
  const stateRevision = commitImmutableState(
    path.join(root, ".clawsweeper-repair", "immutable-state"),
  );

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fs.writeFileSync(mutablePath, `later mutable overwrite ${attempt}\n`);
      const child = spawnSync("bash", ["-c", checkStep.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          JOB_PATH: jobPath,
          STATE_REVISION: stateRevision,
          JOB_SHA256: digest,
          GITHUB_OUTPUT: outputPath,
        },
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(fs.readFileSync(mutablePath), immutableBytes);
    }
    assert.equal(
      fs
        .readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line === "job_exists=1").length,
      2,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable worker handoff fails closed on a digest mismatch", () => {
  const workflow = parse(fs.readFileSync(workerWorkflowPath, "utf8"));
  const checkStep = workflow.jobs.cluster.steps.find(
    (step: { name?: string }) => step.name === "Check job file",
  );
  assert.equal(typeof checkStep?.run, "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-immutable-mismatch-"));
  const jobPath = "jobs/openclaw/inbox/cluster-openclaw-openclaw-def.md";
  const mutablePath = path.join(root, jobPath);
  const immutablePath = path.join(root, ".clawsweeper-repair", "immutable-state", jobPath);
  fs.mkdirSync(path.dirname(mutablePath), { recursive: true });
  fs.mkdirSync(path.dirname(immutablePath), { recursive: true });
  fs.writeFileSync(mutablePath, "mutable job\n");
  fs.writeFileSync(immutablePath, "immutable job\n");
  const stateRevision = commitImmutableState(
    path.join(root, ".clawsweeper-repair", "immutable-state"),
  );

  try {
    const child = spawnSync("bash", ["-c", checkStep.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        JOB_PATH: jobPath,
        STATE_REVISION: stateRevision,
        JOB_SHA256: "0".repeat(64),
        GITHUB_OUTPUT: path.join(root, "output.txt"),
      },
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Immutable job SHA-256 mismatch/);
    assert.equal(fs.readFileSync(mutablePath, "utf8"), "mutable job\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repair dispatch binds dedupe to immutable state and job bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-dispatch-receipt-"));
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const jobPath = path.join(
    process.cwd(),
    "jobs",
    `fixture-${unique}`,
    "inbox",
    `clawsweeper-commit-fixture-${unique}-repo-${"a".repeat(12)}.md`,
  );
  const relativeJobPath = path.relative(process.cwd(), jobPath);
  const binDir = path.join(root, "bin");
  const ghPath = path.join(binDir, "gh");
  const ghLog = path.join(root, "gh.log");
  const stateRevision = "b".repeat(40);
  let jobBytes = `---
repo: fixture-${unique}/repo
cluster_id: gitcrawl-${Date.now()}-${unique}
mode: autonomous
job_intent: repair_cluster
allowed_actions:
  - fix
candidates:
  - "#1"
source: clawsweeper
---

# immutable dispatch fixture
`;
  let jobSha256 = createHash("sha256").update(jobBytes).digest("hex");
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(jobPath, jobBytes);
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "api") {
  process.stdout.write("[]");
  process.exit(0);
}
fs.appendFileSync(process.env.MOCK_GH_LOG, JSON.stringify(args) + "\\n");
`,
    { mode: 0o755 },
  );

  try {
    const dispatch = (includeImmutableReceipt = true) =>
      spawnSync(
        process.execPath,
        [
          path.resolve("dist/repair/dispatch-jobs.js"),
          relativeJobPath,
          "--mode",
          "autonomous",
          "--dispatch-key",
          `commit-${unique}`,
          ...(includeImmutableReceipt
            ? ["--state-revision", stateRevision, "--job-sha256", jobSha256]
            : []),
          "--max-live-workers",
          "1",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            MOCK_GH_LOG: ghLog,
            CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: path.join(root, "ledger"),
            CLAWSWEEPER_REPO: "openclaw/clawsweeper",
          },
        },
      );
    const first = dispatch();
    const second = dispatch();
    jobBytes = `${jobBytes}\nchanged immutable bytes\n`;
    jobSha256 = createHash("sha256").update(jobBytes).digest("hex");
    fs.writeFileSync(jobPath, jobBytes);
    const changed = dispatch();
    const missingReceipt = dispatch(false);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(missingReceipt.status, 1);
    assert.match(missingReceipt.stderr, /required for immutable job handoff/);
    const calls = fs
      .readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], calls[1]);
    assert.notDeepEqual(calls[0], calls[2]);
    assert.ok(calls[0]?.includes(`state_revision=${stateRevision}`));
    assert.ok(calls[2]?.includes(`job_sha256=${jobSha256}`));
    const firstDispatchKey = calls[0]?.find((arg) => arg.startsWith("dispatch_key="));
    const changedDispatchKey = calls[2]?.find((arg) => arg.startsWith("dispatch_key="));
    assert.match(firstDispatchKey ?? "", /^dispatch_key=repair-dispatch-[a-f0-9]{24}$/);
    assert.match(changedDispatchKey ?? "", /^dispatch_key=repair-dispatch-[a-f0-9]{24}$/);
    assert.notEqual(firstDispatchKey, changedDispatchKey);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), "jobs", `fixture-${unique}`), {
      recursive: true,
      force: true,
    });
  }
});

test("commit finding workflows bind terminal receipts and ignore ledger-only artifacts", () => {
  const intake = fs.readFileSync(commitIntakeWorkflowPath, "utf8");
  const worker = fs.readFileSync(workerWorkflowPath, "utf8");

  assert.match(intake, /"Intake commit finding" "Complete durable intake handoff"/);
  assert.match(
    intake,
    /Complete durable intake handoff[\s\S]*PREPARE_OUTCOME[\s\S]*PUBLISH_OUTCOME[\s\S]*DISPATCH_OUTCOME/,
  );
  assert.match(
    intake,
    /SHOULD_REPAIR[\s\S]*"\$PREPARE_OUTCOME" != "success"[\s\S]*"\$PUBLISH_OUTCOME" != "success"[\s\S]*"\$SHOULD_REPAIR" = "true"[\s\S]*"\$DISPATCH_OUTCOME" != "success"/,
  );
  assert.match(
    intake,
    /--state-revision "\$\{\{ steps\.published-job\.outputs\.state_revision \}\}"/,
  );
  assert.match(intake, /--job-sha256 "\$\{\{ steps\.published-job\.outputs\.job_sha256 \}\}"/);
  assert.match(worker, /ref: \$\{\{ inputs\.state_revision \}\}/);
  assert.match(worker, /Immutable job SHA-256 mismatch/);
  assert.match(worker, /Immutable authorization job SHA-256 mismatch/);
  assert.match(worker, /name: clawsweeper-repair-worker-action-ledger-cluster-/);
  assert.match(worker, /name: clawsweeper-repair-worker-action-ledger-execute-/);
  assert.match(worker, /name: clawsweeper-repair-worker-action-ledger-mutate-/);
  assert.doesNotMatch(worker, /name: clawsweeper-repair-action-ledger-(?:cluster|execute|mutate)-/);
});

test("all production dispatch callers require exact published job revisions", () => {
  const commit = fs.readFileSync(commitIntakeWorkflowPath, "utf8");
  const issue = fs.readFileSync(issueIntakeWorkflowPath, "utf8");
  const cluster = fs.readFileSync(clusterIntakeWorkflowPath, "utf8");
  const createJob = fs.readFileSync(createJobPath, "utf8");
  const dispatcher = fs.readFileSync("src/repair/dispatch-jobs.ts", "utf8");
  const worker = fs.readFileSync(workerWorkflowPath, "utf8");

  for (const intake of [commit, issue, cluster]) {
    assert.match(intake, /git -C "\$CLAWSWEEPER_STATE_DIR" rev-parse HEAD/);
    assert.match(
      intake,
      /git -C "\$CLAWSWEEPER_STATE_DIR" show "\$\{state_revision\}:\$\{(?:JOB_PATH|job)\}"/,
    );
    assert.match(intake, /--state-revision/);
    assert.match(intake, /--job-sha256/);
  }
  assert.match(createJob, /dispatch && \(!stateRevision \|\| !jobSha256\)/);
  assert.match(createJob, /git", \["show", `\$\{revision\}:\$\{relativePath\}`\]/);
  assert.match(createJob, /local job bytes do not match published state/);
  assert.match(createJob, /"repair:dispatch"/);
  assert.doesNotMatch(createJob, /dispatch_command|npm", \["run", "dispatch"/);
  assert.match(dispatcher, /usage: node scripts\/dispatch-jobs\.ts <job\.md> \[--mode/);
  assert.doesNotMatch(dispatcher, /<job\.md> \[\.\.\.\]/);
  assert.match(worker, /state_revision:[\s\S]*required: true/);
  assert.match(worker, /job_sha256:[\s\S]*required: true/);
  assert.match(worker, /expected_title="\$\{title\} \[\$\{DISPATCH_KEY\}\] \(\$\{JOB_SHA256\}\)"/);
  assert.match(worker, /group:.*inputs\.state_revision.*inputs\.job_sha256/);
  assert.doesNotMatch(worker, /scripts\/restore-repair-job\.sh "\$JOB_PATH"/);
});

test("repair operational callers resolve immutable state before dedupe and dispatch", () => {
  const requeue = fs.readFileSync("src/repair/requeue-job.ts", "utf8");
  const selfHeal = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");
  const finalizer = fs.readFileSync("src/repair/finalize-open-prs.ts", "utf8");
  const conflict = fs.readFileSync("src/repair/conflict-self-heal.ts", "utf8");

  assert.match(selfHeal, /state_revision=/);
  assert.match(selfHeal, /job_sha256=/);
  for (const source of [requeue, finalizer, conflict]) {
    assert.match(source, /immutableJobDispatchArgs/);
  }
  assert.match(requeue, /resolveStateJobIdentity\(\{/);
  assert.match(requeue, /sourceStateRevision: immutableJob\.stateRevision/);
  assert.match(selfHeal, /resolveRunRecordJob\(record, sourceJob\)/);
  assert.match(
    selfHeal,
    /resolveStateJobIdentity\(\{[\s\S]*jobPath: sourceJob,[\s\S]*stateRevision,[\s\S]*jobSha256/,
  );
  assert.doesNotMatch(selfHeal, /resolveCurrentStateJobIdentity\(sourceJob\)/);
  assert.match(selfHeal, /activeJobGenerationKey\(record\.source_job, record\.source_job_sha256\)/);
  assert.match(finalizer, /const jobPath = normalizedFinalizerDispatchJobPath\(pr\.job_path\)/);
  assert.match(finalizer, /const immutableJob = resolveCurrentStateJobIdentity\(jobPath\)/);
  assert.ok(
    finalizer.indexOf("resolveCurrentStateJobIdentity(jobPath)") <
      finalizer.indexOf("resolveDispatchMode(immutableJob)"),
  );
  assert.match(finalizer, /jobSha256: candidate\.job_sha256/);
  assert.match(conflict, /if \(prepared\.length > 0\) publishSelfHealJobs\(\)/);
  assert.ok(
    conflict.indexOf("publishSelfHealJobs()") <
      conflict.indexOf("resolveCurrentStateJobIdentity(candidate.job_path)"),
  );
  assert.ok(
    conflict.indexOf("resolveCurrentStateJobIdentity(candidate.job_path)") <
      conflict.indexOf("dispatchRepair(candidate)"),
  );
});

test("removed immutable jobs are recognized despite appended git diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-missing-immutable-job-"));
  fs.writeFileSync(path.join(root, "README.md"), "state fixture\n");
  commitImmutableState(root);

  assert.throws(
    () =>
      resolveCurrentStateJobIdentity("jobs/openclaw/inbox/deleted.md", {
        stateRoot: root,
      }),
    (error) => {
      assert.equal(isMissingImmutableJobError(error), true);
      assert.match(String(error), /fatal: path .* does not exist/);
      return true;
    },
  );
  assert.equal(isMissingImmutableJobError(new Error("state revision is malformed")), false);
});

test("create-job refuses dispatch before a published immutable identity exists", () => {
  const clusterId = `immutable-create-job-${randomUUID()}`;
  const jobPath = path.resolve(`jobs/openclaw/inbox/${clusterId}.md`);
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/repair/create-job.js"),
      "--repo",
      "openclaw/openclaw",
      "--refs",
      "1",
      "--prompt",
      "test immutable dispatch",
      "--cluster-id",
      clusterId,
      "--no-check-existing",
      "--dispatch",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /--dispatch requires --state-revision and --job-sha256 after the job is published/,
  );
  assert.equal(fs.existsSync(jobPath), false);
});

function commitImmutableState(root: string): string {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
