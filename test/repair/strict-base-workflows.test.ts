import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const REQUIRED_BINDINGS = [
  "CLAWSWEEPER_AUTHENTICATED_APP_ID",
  "CLAWSWEEPER_AUTHENTICATED_APP_SLUG",
  "CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID",
];

const OBSOLETE_RULESET_BINDINGS = [
  "CLAWSWEEPER_RULESET_APP_ID",
  "CLAWSWEEPER_RULESET_APP_SLUG",
  "CLAWSWEEPER_RULESET_INSTALLATION_ID",
  "CLAWSWEEPER_RULESET_GH_TOKEN",
];

test("every merge-capable workflow binds policy reads to its exact-repository mutation credential", () => {
  const expectedStepCounts = new Map([
    [".github/workflows/repair-cluster-worker.yml", 3],
    [".github/workflows/repair-comment-router.yml", 2],
    [".github/workflows/sweep.yml", 1],
  ]);

  for (const [file, expectedStepCount] of expectedStepCounts) {
    const workflow = parse(fs.readFileSync(file, "utf8"));
    assert.equal(workflow.env?.CLAWSWEEPER_APP_SLUG, "clawsweeper", file);
    let mergeStepCount = 0;

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = (job as { steps?: WorkflowStep[] }).steps ?? [];
      for (const candidate of steps) {
        assert.equal(
          candidate.with?.["permission-administration"],
          undefined,
          `${file}:${jobName}:${candidate.name} must not request repository administration`,
        );
      }

      for (const step of steps) {
        if (
          !/(?:pnpm run repair:(?:apply-result|post-flight|comment-router)\b|node dist\/repair\/(?:apply-result|post-flight|comment-router)\.js\b)/.test(
            step.run ?? "",
          )
        ) {
          continue;
        }
        mergeStepCount += 1;
        for (const name of REQUIRED_BINDINGS) {
          assert.ok(step.env?.[name], `${file}:${jobName}:${step.name} is missing ${name}`);
        }
        for (const name of OBSOLETE_RULESET_BINDINGS) {
          assert.equal(
            step.env?.[name],
            undefined,
            `${file}:${jobName}:${step.name} must read policy as its mutation caller`,
          );
        }

        const mutationTokenId = outputStep(step.env?.GH_TOKEN, "token");
        assert.ok(mutationTokenId, `${file}:${jobName}:${step.name} has no mutation token output`);
        assert.equal(
          outputStep(step.env?.CLAWSWEEPER_AUTHENTICATED_APP_SLUG, "app-slug"),
          mutationTokenId,
        );
        assert.equal(
          outputStep(step.env?.CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID, "installation-id"),
          mutationTokenId,
        );

        const mutationToken = steps.find((candidate) => candidate.id === mutationTokenId);
        assert.match(String(mutationToken?.uses ?? ""), /actions\/create-github-app-token@/);
        assert.ok(mutationToken?.with?.owner, `${file}:${mutationTokenId} has no owner scope`);
        assert.ok(mutationToken?.with?.repositories, `${file}:${mutationTokenId} is owner-wide`);
        assert.equal(
          mutationToken?.with?.["permission-administration"],
          undefined,
          `${file}:${mutationTokenId} must not carry administration permission`,
        );

        assertIdentityBinding(
          file,
          jobName,
          steps,
          step.env?.CLAWSWEEPER_AUTHENTICATED_APP_ID,
          mutationTokenId,
        );
      }
    }

    assert.equal(mergeStepCount, expectedStepCount, `${file} merge-step inventory drifted`);
  }
});

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

function outputStep(value: unknown, output: string): string | null {
  const match = String(value ?? "").match(
    new RegExp(`^\\$\\{\\{ steps\\.([A-Za-z0-9_-]+)\\.outputs\\.${output} \\}\\}$`),
  );
  return match?.[1] ?? null;
}

function assertIdentityBinding(
  file: string,
  jobName: string,
  steps: WorkflowStep[],
  appIdExpression: unknown,
  tokenStepId: string,
) {
  const identityStepId = outputStep(appIdExpression, "app_id");
  assert.ok(identityStepId, `${file}:${jobName} has no App identity output`);
  const identityStep = steps.find((candidate) => candidate.id === identityStepId);
  assert.equal(outputStep(identityStep?.env?.GH_TOKEN, "token"), tokenStepId);
  assert.equal(outputStep(identityStep?.env?.APP_SLUG, "app-slug"), tokenStepId);
  assert.match(String(identityStep?.run ?? ""), /gh api "apps\/\$APP_SLUG" --jq '\.id'/);
}
