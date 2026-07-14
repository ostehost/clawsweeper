import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const intakeWorkflows = [
  ".github/workflows/repair-commit-finding-intake.yml",
  ".github/workflows/repair-issue-implementation-intake.yml",
];

function workflowRunScripts(workflowPath: string): { label: string; run: string }[] {
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as {
    jobs?: Record<string, { steps?: { name?: string; run?: string }[] }>;
  };
  const scripts: { label: string; run: string }[] = [];
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (typeof step.run !== "string") continue;
      scripts.push({ label: `${jobName}/${step.name ?? index}`, run: step.run });
    }
  }
  return scripts;
}

test("repository dispatch payloads cannot select repair runners", () => {
  for (const path of intakeWorkflows) {
    const workflow = fs.readFileSync(path, "utf8");
    assert.doesNotMatch(
      workflow,
      /github\.event\.client_payload\.(?:intake_runner|runner|execution_runner)/,
      path,
    );
  }
});

test("repair worker passes the job input to shell scripts through the environment", () => {
  const path = ".github/workflows/repair-cluster-worker.yml";
  const workflow = fs.readFileSync(path, "utf8");
  const directJobInputLines = workflow
    .split("\n")
    .filter((line) => line.includes("${{ inputs.job }}"));

  assert.ok(directJobInputLines.length > 0);
  for (const line of directJobInputLines) {
    assert.match(
      line,
      /^\s*(?:run-name:|group:|JOB_PATH:|SOURCE_JOB_PATH:|sparse-checkout:)/,
      line,
    );
  }
  assert.match(workflow, /args=\("\$JOB_PATH" --mode "\$worker_mode"\)/);
});

test("repair worker keeps every write credential out of Codex and target execution jobs", () => {
  const workflowPath = ".github/workflows/repair-cluster-worker.yml";
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const parsed = YAML.parse(workflow) as {
    jobs: Record<
      string,
      {
        "runs-on"?: string;
        steps?: Array<{
          name?: string;
          id?: string;
          uses?: string;
          if?: string;
          with?: Record<string, unknown>;
          env?: Record<string, unknown>;
          run?: string;
        }>;
      }
    >;
  };
  const cluster = parsed.jobs.cluster;
  const execute = parsed.jobs.execute;
  const publish = parsed.jobs.publish;
  assert.ok(cluster && execute && publish);

  for (const [jobName, job] of [
    ["cluster", cluster],
    ["execute", execute],
  ] as const) {
    const rendered = JSON.stringify(job);
    assert.doesNotMatch(
      rendered,
      /permission-(?:actions|contents|issues|pull-requests|workflows)":"write/,
    );
    assert.doesNotMatch(rendered, /create-state-token/);
    const stateSetup = job.steps?.find((step) => step.uses === "./.github/actions/setup-state");
    assert.equal(stateSetup?.with?.["persist-credentials"], false, jobName);
  }

  const executeText = JSON.stringify(execute);
  assert.match(executeText, /prepare-publication/);
  assert.doesNotMatch(executeText, /target_post_flight_token|requeue-token|STATUS_INGEST_TOKEN/);
  assert.equal(cluster["runs-on"], "blacksmith-4vcpu-ubuntu-2404");
  assert.equal(execute["runs-on"], "blacksmith-16vcpu-ubuntu-2404");
  assert.equal(publish["runs-on"], "ubuntu-latest");
  assert.doesNotMatch(JSON.stringify(publish), /setup-codex|setup-bun|prepareTargetToolchain/);
});

test("isolated publisher defers prepared code and mints a narrow token only for no-publication", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const publishStart = workflow.indexOf("\n  publish:\n");
  assert.notEqual(publishStart, -1);
  const publisher = workflow.slice(publishStart);
  const groundTruth = publisher.indexOf("Download immutable cluster result ground truth");
  const stateTruth = publisher.indexOf("Checkout immutable job ground truth");
  const validation = publisher.indexOf("Independently validate publication authority");
  const targetWrite = publisher.indexOf(
    "Create narrow no-publication mutation token after validation",
  );
  const publication = publisher.indexOf("Publish independently validated outcome");
  assert.ok(
    groundTruth >= 0 &&
      stateTruth > groundTruth &&
      validation > stateTruth &&
      targetWrite > validation &&
      publication > targetWrite,
  );
  assert.doesNotMatch(publisher, /Create state publication token|Create central requeue token/);
  assert.match(publisher, /artifact-ids: \${{ needs\.execute\.outputs\.prepared_artifact_id }}/);
  assert.match(publisher, /steps\.publication_validation\.outputs\.ready == 'true'/);
  const afterWriteToken = publisher.slice(targetWrite);
  assert.doesNotMatch(afterWriteToken, /pnpm run/);
  assert.doesNotMatch(afterWriteToken, /setup-codex|setup-bun/);
  assert.match(
    publisher,
    /target_post_flight_token[\s\S]*?mode == 'no-publication'[\s\S]*?permission-issues: write[\s\S]*?permission-pull-requests: write/,
  );
  assert.doesNotMatch(publisher, /permission-(?:actions|contents|workflows): write/);
  assert.match(
    publisher,
    /env -u GH_TOKEN -u GITHUB_TOKEN -u TARGET_MUTATION_TOKEN[\s\S]*?--publish-prepared-publication/,
  );
  const deferredUpload = publisher.slice(
    publisher.indexOf("- name: Upload immutable deferred publication receipt"),
    publisher.indexOf("- name: Bind authenticated mutation App identity"),
  );
  assert.match(deferredUpload, /mode == 'prepared'/);
  assert.match(deferredUpload, /prepared-publication-validation\.json/);
  assert.match(deferredUpload, /prepared-publication\.json/);
  assert.match(deferredUpload, /prepared-publication\.bundle/);
  assert.match(deferredUpload, /\${{ env\.JOB_PATH }}/);
  assert.match(deferredUpload, /steps\.ground_truth\.outputs\.result_path/);
  assert.match(deferredUpload, /steps\.ground_truth\.outputs\.run_dir }}\/cluster-plan\.json/);
  assert.match(deferredUpload, /fix-execution-report\.json/);
  assert.match(deferredUpload, /include-hidden-files: true/);
  assert.doesNotMatch(deferredUpload, /\*\*|\.clawsweeper-prepared\/$/m);
  for (const step of [
    "Publish automatic implementation build status",
    "Bind authenticated mutation App identity",
    "Apply safe closure actions",
    "Post-flight finalize fix PRs",
    "Apply post-flight closeouts",
    "Publish automatic implementation completion status",
  ]) {
    const start = publisher.indexOf(`- name: ${step}`);
    assert.notEqual(start, -1, step);
    assert.match(
      publisher.slice(start, publisher.indexOf("\n      - name:", start + 1)),
      /mode == 'no-publication'/,
    );
  }
});

test("untrusted phases use a dedicated principal and stage only exact bounded files", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const executeStart = workflow.indexOf("\n  execute:\n");
  const publishStart = workflow.indexOf("\n  publish:\n");
  const cluster = workflow.slice(0, executeStart);
  const execute = workflow.slice(executeStart, publishStart);

  assert.match(cluster, /name: Run isolated worker and stage exact ground truth/);
  assert.match(cluster, /trusted-principal-main\.js/);
  assert.match(cluster, /--file result\.json:16777216/);
  assert.match(cluster, /--file cluster-plan\.json:16777216/);
  assert.match(cluster, /--principal-uid "\$principal_uid"/);
  assert.match(cluster, /--stage-owner-uid "\$runner_uid"/);
  assert.match(cluster, /--no-create-home --shell \/usr\/sbin\/nologin --user-group/);
  assert.match(cluster, /clawsweeper-worker-stage\/result\.json/);
  assert.match(cluster, /clawsweeper-worker-stage\/cluster-plan\.json/);
  assert.doesNotMatch(
    cluster,
    /name: Upload worker transfer artifacts[\s\S]*?path: \.clawsweeper-repair\/runs/,
  );

  assert.match(execute, /name: Execute isolated fix preparation and stage exact publication/);
  assert.match(execute, /trusted-principal-main\.js/);
  assert.match(execute, /--file prepared-publication\.json:1048576/);
  assert.match(execute, /--file prepared-publication\.bundle:134217728/);
  assert.match(execute, /--allow-empty-transfer/);
  assert.match(execute, /has_prepared=true/);
  assert.match(execute, /has_prepared=false/);
  assert.match(execute, /isolated prepared transfer must contain both files or neither/);
  assert.match(execute, /"\$JOB_PATH" "\$RESULT_PATH" --prepare-publication/);
  assert.doesNotMatch(execute, /--latest/);
  assert.match(execute, /clawsweeper-prepared-stage\/prepared-publication\.json/);
  assert.match(execute, /clawsweeper-prepared-stage\/prepared-publication\.bundle/);
  assert.doesNotMatch(execute, /path: \.clawsweeper-repair\/runs\/\*\*\/prepared-publication/);
  assert.doesNotMatch(
    workflow,
    /run-repair-untrusted|Stage bounded worker transfer|Stage bounded prepared/,
  );
  assert.equal((workflow.match(/trusted-principal-main\.js/g) ?? []).length, 2);
  assert.doesNotMatch(
    workflow,
    /--pass-env (?:ACTIONS_|GITHUB_(?:ENV|OUTPUT|PATH|STATE|STEP_SUMMARY))/,
  );
  assert.doesNotMatch(workflow, /--pass-env CLAWSWEEPER_CRABFLEET_/);
  assert.equal((cluster.match(/persist-credentials: false/g) ?? []).length >= 2, true);
  assert.match(execute, /persist-credentials: false/);
});

test("prepare executor scrubs workflow command files and publisher rederives artifact identity", () => {
  const source = fs.readFileSync("src/repair/execute-fix-artifact.ts", "utf8");
  assert.match(source, /function scrubUntrustedProcessEnvironment/);
  assert.match(source, /"GITHUB_STEP_SUMMARY"/);
  assert.match(source, /\^ACTIONS_/);
  assert.match(source, /CLAWSWEEPER_CRABFLEET_/);
  assert.match(source, /manifest\.job_sha256 !== sha256File\(jobPath\)/);
  assert.match(source, /manifest\.result_sha256 !== sha256File\(resultPath\)/);
  assert.match(source, /manifest\.bundle_sha256 !== sha256File\(bundlePath\)/);
  assert.match(source, /independently derived publication paths do not match/);
  assert.match(source, /prepared contributor repair source branch identity or lease changed/);
  assert.match(source, /prepared replacement branch is not descended from the live remote lease/);
  assert.match(source, /changed files outside immutable likely_files scope/);
  assert.match(source, /prepared contributor repair kind conflicts with immutable fix strategy/);
  assert.match(source, /persistedReport: LooseRecord = \{/);
  assert.match(source, /prepared-publication-validation\.json/);
  assert.match(source, /required_publisher: "fork-or-target-native-trusted-publisher"/);
  assert.match(source, /action: "publication_deferred"/);
  assert.match(source, /target_mutation: false/);
  assert.match(source, /merge_allowed: false/);
  const deferredStart = source.indexOf("function deferValidatedPreparedPublication(");
  const deferredEnd = source.indexOf("function writeReport(", deferredStart);
  assert.ok(deferredStart >= 0 && deferredEnd > deferredStart);
  const deferred = source.slice(deferredStart, deferredEnd);
  assert.doesNotMatch(deferred, /runTrustedGitNetwork|\["push"|"pr",\s*"create"|GH_TOKEN/);
  const publishModeStart = source.indexOf(
    "if (validatePreparedPublicationOnly || publishPreparedPublication)",
  );
  const publishModeEnd = source.indexOf("const sourceBranchPreflight", publishModeStart);
  const publishMode = source.slice(publishModeStart, publishModeEnd);
  assert.match(publishMode, /readPreparedPublicationValidationReceipt/);
  assert.match(publishMode, /deferPublication: true/);
  assert.doesNotMatch(publishMode, /publishReportOutcome|publishValidatedPreparedPublication/);
});

test("all fix execution workflows route through the isolated prepare and publisher jobs", () => {
  const workflowDir = ".github/workflows";
  const callers: string[] = [];
  for (const entry of fs.readdirSync(workflowDir)) {
    if (!entry.endsWith(".yml")) continue;
    const workflowPath = path.join(workflowDir, entry);
    const source = fs.readFileSync(workflowPath, "utf8");
    if (/repair:execute-fix|execute-fix-artifact\.js/.test(source)) callers.push(workflowPath);
  }
  assert.deepEqual(callers, [".github/workflows/repair-cluster-worker.yml"]);

  const cluster = fs.readFileSync(callers[0], "utf8");
  const executeStart = cluster.indexOf("\n  execute:\n");
  const publishStart = cluster.indexOf("\n  publish:\n");
  const execute = cluster.slice(executeStart, publishStart);
  const publisher = cluster.slice(publishStart);
  assert.match(execute, /--prepare-publication/);
  assert.doesNotMatch(
    execute,
    /permission-(?:actions|contents|issues|pull-requests|workflows): write/,
  );
  assert.match(publisher, /--validate-prepared-publication/);
  assert.match(publisher, /--publish-prepared-publication/);
  assert.match(publisher, /--validate-no-publication/);
  assert.match(publisher, /--publish-no-publication/);
});

test("commit finding intake publishes state then dispatches the isolated fixed-runner worker", () => {
  const source = fs.readFileSync(".github/workflows/repair-commit-finding-intake.yml", "utf8");
  assert.doesNotMatch(source, /repair:execute-fix|repair:post-flight|setup-codex/);
  const statePublish = source.indexOf("- name: Commit intake ledger");
  const dispatchToken = source.indexOf("- name: Create central worker dispatch token");
  const dispatch = source.indexOf("- name: Dispatch isolated repair worker");
  assert.ok(statePublish >= 0 && dispatchToken > statePublish && dispatch > dispatchToken);
  assert.match(source, /permission-contents: read/);
  assert.match(source, /permission-actions: write/);
  assert.match(source, /--runner blacksmith-4vcpu-ubuntu-2404/);
  assert.match(source, /--execution-runner blacksmith-16vcpu-ubuntu-2404/);
});

test("comment router passes replay attempt identities through the environment", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-comment-router.yml", "utf8");
  const directAttemptLines = workflow
    .split("\n")
    .filter(
      (line) => line.includes("inputs.attempt_id") || line.includes("client_payload.attempt_id"),
    );

  assert.equal(directAttemptLines.length, 1);
  for (const line of directAttemptLines) {
    assert.match(line, /^\s*ROUTER_ATTEMPT_ID:/, line);
  }
  assert.equal(workflow.match(/attempt_id="\$ROUTER_ATTEMPT_ID"/g)?.length, 2);
});

test("write-capable workflows never compile event data into shell source", () => {
  for (const workflowPath of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-comment-router.yml",
    ".github/workflows/repair-commit-finding-intake.yml",
    ".github/workflows/repair-issue-implementation-intake.yml",
    ".github/workflows/maintainer-activity-report.yml",
    ".github/workflows/sweep.yml",
  ]) {
    for (const { label, run } of workflowRunScripts(workflowPath)) {
      const expressions = run.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
      for (const expression of expressions) {
        assert.doesNotMatch(
          expression,
          /\b(?:github\.event(?:\.|_name)|inputs\.)/,
          `${workflowPath}:${label}: ${expression}`,
        );
      }
    }
  }
});

test("comment router shell bodies consume only environment-bound workflow values", () => {
  const workflowPath = ".github/workflows/repair-comment-router.yml";
  const workflow = fs.readFileSync(workflowPath, "utf8");

  for (const { label, run } of workflowRunScripts(workflowPath)) {
    assert.doesNotMatch(run, /\$\{\{/, `${label} still contains an expression`);
  }
  assert.equal(
    workflow.match(/ROUTER_TARGET_REPO: \$\{\{ steps\.target\.outputs\.target_repo \}\}/g)?.length,
    2,
  );
  assert.equal(workflow.match(/target_branch="\$ROUTER_TARGET_BRANCH"/g)?.length, 2);
  assert.equal(workflow.match(/force_reprocess="\$ROUTER_FORCE_REPROCESS"/g)?.length, 2);
});

test("comment router publishes each terminal transaction atomically", () => {
  const scripts = workflowRunScripts(".github/workflows/repair-comment-router.yml").filter(
    ({ run }) => run.includes("--rebase-strategy comment-router-ledger"),
  );

  assert.equal(scripts.length, 2);
  for (const { label, run } of scripts) {
    assert.equal(run.match(/repair:publish-main/g)?.length, 1, label);
    assert.match(run, /--path results\/comment-router\.json/);
    assert.match(run, /--path results\/comment-router-latest\.json/);
    assert.match(run, /--path jobs/);
  }
});

test("workflow output validators reject multiline repositories and branches", () => {
  let repositoryOutputs = 0;
  let branchOutputs = 0;
  for (const workflowPath of [
    ".github/workflows/repair-comment-router.yml",
    ".github/workflows/sweep.yml",
  ]) {
    for (const { label, run } of workflowRunScripts(workflowPath)) {
      if (run.includes('echo "target_repo=$target_repo"')) {
        repositoryOutputs += 1;
        assert.ok(
          run.includes('if ! [[ "$target_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then'),
          `${workflowPath}:${label} must validate the complete repository string`,
        );
      }
      if (run.includes('echo "target_branch=$target_branch"')) {
        branchOutputs += 1;
        assert.ok(
          run.includes('if ! [[ "$target_branch" =~ ^[A-Za-z0-9_./-]+$ ]]; then'),
          `${workflowPath}:${label} must validate the complete branch string`,
        );
      }
    }
  }
  assert.equal(repositoryOutputs, 5);
  assert.equal(branchOutputs, 2);

  for (const value of [
    "openclaw/openclaw\ntarget_repo=attacker/repo",
    "main\ntarget_branch=evil",
  ]) {
    const pattern = value.startsWith("openclaw/")
      ? "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
      : "^[A-Za-z0-9_./-]+$";
    const probe = spawnSync("bash", ["-c", '[[ "$VALUE" =~ $PATTERN ]]'], {
      env: { ...process.env, PATTERN: pattern, VALUE: value },
      encoding: "utf8",
    });
    assert.notEqual(probe.status, 0, value);
  }
});

test("exact-review lease outputs reject multiline dispatch identities", () => {
  const claim = workflowRunScripts(".github/workflows/sweep.yml").find(
    ({ label }) => label === "event-review-apply/Claim exact-review queue lease",
  );
  assert.ok(claim);
  assert.ok(
    claim.run.includes('if ! [[ "$QUEUE_LEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then'),
  );
  assert.match(claim.run, /`lease_id=\$\{process\.env\.QUEUE_LEASE_ID\}`/);

  for (const value of ["lease-123\nspoofed_output=value", "lease-123\rspoofed=value"]) {
    const probe = spawnSync(
      "bash",
      ["-c", '[[ "$VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]'],
      { env: { ...process.env, VALUE: value }, encoding: "utf8" },
    );
    assert.notEqual(probe.status, 0, value);
  }
});

test("repair job restoration rejects shell metacharacters and path traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-restore-job-"));
  const restore = path.resolve("scripts/restore-repair-job.sh");
  const invalidPaths = [
    'jobs/openclaw/inbox/automerge-openclaw-openclaw-1"; id; #.md',
    "jobs/../inbox/automerge-openclaw-openclaw-1.md",
    "jobs/openclaw/../../outside/inbox/automerge-openclaw-openclaw-1.md",
  ];

  try {
    for (const jobPath of invalidPaths) {
      const result = spawnSync("bash", [restore, jobPath], { cwd: root, encoding: "utf8" });
      assert.notEqual(result.status, 0, jobPath);
      assert.match(result.stderr, /Invalid job path:/);
    }

    const restorablePath = "jobs/openclaw/inbox/automerge-openclaw-openclaw-1.md";
    const restored = spawnSync("bash", [restore, restorablePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(fs.existsSync(path.join(root, restorablePath)), true);

    const customPath = "jobs/openclaw/cluster-001.md";
    fs.mkdirSync(path.dirname(path.join(root, customPath)), { recursive: true });
    fs.writeFileSync(path.join(root, customPath), "existing job\n");
    const custom = spawnSync("bash", [restore, customPath], { cwd: root, encoding: "utf8" });
    assert.equal(custom.status, 0, custom.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
