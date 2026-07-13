import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/sweep.yml";

test("sweep caller mutations use the validated receipt CLI", () => {
  const source = fs.readFileSync(workflowPath, "utf8");
  const workflow = parse(source);

  assert.doesNotMatch(source, /\bgh workflow run\b/);
  assert.doesNotMatch(source, /\bgh "\$\{args\[@\]\}"/);
  assert.doesNotMatch(source, /repos\/\$GITHUB_REPOSITORY\/dispatches/);

  let dispatchCount = 0;
  let reactionMutationCount = 0;
  for (const [jobId, job] of Object.entries(workflow.jobs) as Array<
    [string, { steps?: WorkflowStep[] }]
  >) {
    for (const step of job.steps ?? []) {
      const run = String(step.run ?? "");
      if (/\bgh api\b/.test(run) && /(?:-X|--method)\s+(?:POST|DELETE)\b/.test(run)) {
        assert.fail(`${jobId}:${step.name ?? "unnamed"} contains a raw mutating gh api call`);
      }
      if (/sweep-mutation-cli\.js (?:workflow|repository) dispatch/.test(run)) {
        const dispatches =
          run.match(/sweep-mutation-cli\.js (?:workflow|repository) dispatch/g) ?? [];
        const businessKeys = run.match(/--business-key\s+["']?[^\\\n]+/g) ?? [];
        dispatchCount += dispatches.length;
        assert.equal(
          businessKeys.length,
          dispatches.length,
          `${jobId}:${step.name ?? "unnamed"} must bind every dispatch to a business key`,
        );
        assert.match(run, /--business-key\s+["'][^"']*\$GITHUB_RUN_ID/);
        assert.match(run, /--repo\s+/);
      }
      if (/sweep-mutation-cli\.js reaction (?:add|delete)/.test(run)) {
        reactionMutationCount +=
          run.match(/sweep-mutation-cli\.js reaction (?:add|delete)/g)?.length ?? 0;
      }
    }
  }

  assert.equal(dispatchCount, 13);
  assert.equal(reactionMutationCount, 4);
  assert.match(source, /gh api -X GET[\s\S]*reactions/);
  assert.doesNotMatch(source, /for attempt in 1 2 3; do[\s\S]{0,500}sweep-mutation-cli/);
  assert.match(source, /hard runner loss[\s\S]{0,160}at-least-once safe/);
  assert.match(
    fs.readFileSync("src/repair/sweep-mutation.ts", "utf8"),
    /hard runner loss before receipt publication[\s\S]*at-least-once delivery/,
  );
});

test("each sweep caller producer finalizes and publishes after its last mutation", () => {
  const workflow = parse(fs.readFileSync(workflowPath, "utf8"));
  const expectations = {
    "event-review-apply": {
      finalize: "Finalize exact event action ledger",
      publish: "Publish exact event action ledger",
    },
    "requeue-source-revision-drift": {
      finalize: "Finalize source-drift dispatch action ledger",
      publish: "Publish source-drift dispatch action ledger",
    },
    publish: {
      finalize: "Finalize sweep caller action ledger",
      publish: "Publish sweep caller action ledger",
    },
    "recover-review-failures": {
      finalize: "Finalize review recovery action ledger",
      publish: "Publish review recovery action ledger",
    },
    "audit-dashboard": {
      finalize: "Finalize sweep audit state action ledger",
      publish: "Publish immutable sweep audit state action ledger",
    },
    "apply-existing": {
      finalize: "Finalize apply action ledger",
      publish: "Publish apply action events",
    },
  } as const;

  for (const [jobId, expected] of Object.entries(expectations)) {
    const steps = (workflow.jobs[jobId].steps ?? []) as WorkflowStep[];
    const setupIndex = steps.findIndex((step) =>
      String(step.uses ?? "").includes("setup-action-ledger"),
    );
    const mutationIndexes = steps
      .map((step, index) => (String(step.run ?? "").includes("sweep-mutation-cli.js") ? index : -1))
      .filter((index) => index >= 0);
    const dispatchIndexes = steps
      .map((step, index) =>
        /sweep-mutation-cli\.js (?:workflow|repository) dispatch/.test(String(step.run ?? ""))
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    const stateIndex = steps.findIndex((step) => String(step.uses ?? "").includes("setup-state"));
    const pnpmIndex = steps.findIndex((step) => String(step.uses ?? "").includes("setup-pnpm"));
    const finalizeIndex = steps.findIndex((step) => step.name === expected.finalize);
    const publishIndex = steps.findIndex((step) => step.name === expected.publish);

    assert.ok(setupIndex >= 0, `${jobId} must initialize its action ledger`);
    assert.ok(mutationIndexes.length > 0, `${jobId} must contain a caller mutation`);
    assert.ok(setupIndex < mutationIndexes[0]!, `${jobId} must initialize before mutation`);
    assert.ok(pnpmIndex < mutationIndexes[0]!, `${jobId} must build the mutation CLI first`);
    if (dispatchIndexes.length > 0) {
      assert.ok(stateIndex < dispatchIndexes[0]!, `${jobId} must hydrate durable receipts first`);
    }
    assert.ok(
      finalizeIndex > mutationIndexes.at(-1)!,
      `${jobId} must finalize after its last caller mutation`,
    );
    assert.match(String(steps[finalizeIndex]?.if ?? ""), /always\(\)/);
    assert.ok(publishIndex > finalizeIndex, `${jobId} must publish after finalization`);
    assert.match(String(steps[publishIndex]?.if ?? ""), /always\(\)/);
  }
});

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
};
