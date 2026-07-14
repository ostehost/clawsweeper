import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveWorkerPublicationCohort,
  selectLatestAttemptArtifact,
  selectLatestJobResult,
  WORKER_CLUSTER_JOB_NAME,
  WORKER_EXECUTE_JOB_NAME,
  WORKER_PUBLISH_JOB_NAME,
} from "../../src/repair/workflow-attempt-cohort.ts";

const workerWorkflow = readFileSync(
  new URL("../../.github/workflows/repair-cluster-worker.yml", import.meta.url),
  "utf8",
);

test("publication cohort job names match the worker workflow", () => {
  assert.equal(workflowJobName(workerWorkflow, "cluster"), WORKER_CLUSTER_JOB_NAME);
  assert.equal(workflowJobName(workerWorkflow, "execute"), WORKER_EXECUTE_JOB_NAME);
  assert.equal(workflowJobName(workerWorkflow, "publish"), WORKER_PUBLISH_JOB_NAME);
});

test("latest attempt artifact selection resumes from the newest completed producer", () => {
  const pages = [
    {
      artifacts: [
        artifact(101, "clawsweeper-repair-worker-9000-1"),
        artifact(102, "clawsweeper-repair-worker-9000-2", true),
        artifact(103, "clawsweeper-repair-worker-9000-3"),
      ],
    },
  ];

  assert.deepEqual(selectLatestAttemptArtifact(pages, "clawsweeper-repair-worker-9000", 2), {
    id: 101,
    name: "clawsweeper-repair-worker-9000-1",
    attempt: 1,
  });
  assert.deepEqual(selectLatestAttemptArtifact(pages, "clawsweeper-repair-worker-9000", 3), {
    id: 103,
    name: "clawsweeper-repair-worker-9000-3",
    attempt: 3,
  });
});

test("latest attempt artifact selection rejects duplicate producer artifacts", () => {
  const pages = [
    {
      artifacts: [
        artifact(101, "clawsweeper-repair-worker-9000-2"),
        artifact(102, "clawsweeper-repair-worker-9000-2"),
      ],
    },
  ];

  assert.throws(
    () => selectLatestAttemptArtifact(pages, "clawsweeper-repair-worker-9000", 2),
    /artifact is ambiguous/,
  );
});

test("job selection walks attempts backwards without mistaking older jobs for current jobs", () => {
  const inventories = [
    {
      attempt: 1,
      pages: [
        {
          jobs: [
            { name: WORKER_CLUSTER_JOB_NAME, conclusion: "success" },
            { name: WORKER_EXECUTE_JOB_NAME, conclusion: "failure" },
          ],
        },
      ],
    },
    {
      attempt: 2,
      pages: [
        {
          jobs: [{ name: WORKER_EXECUTE_JOB_NAME, conclusion: "success" }],
        },
      ],
    },
  ];

  assert.deepEqual(selectLatestJobResult(inventories, WORKER_CLUSTER_JOB_NAME, 2), {
    attempt: 1,
    result: "success",
  });
  assert.deepEqual(selectLatestJobResult(inventories, WORKER_EXECUTE_JOB_NAME, 2), {
    attempt: 2,
    result: "success",
  });
});

test("publication cohort binds each ledger to the attempt that produced its job", () => {
  const artifactPages = [
    {
      artifacts: [
        artifact(101, "clawsweeper-repair-worker-9000-1"),
        artifact(102, "clawsweeper-repair-worker-action-ledger-cluster-9000-1"),
        artifact(103, "clawsweeper-repair-9000-2"),
        artifact(104, "clawsweeper-repair-worker-action-ledger-execute-9000-2"),
        artifact(105, "clawsweeper-repair-worker-action-ledger-publish-9000-2"),
      ],
    },
  ];
  const jobInventories = [
    {
      attempt: 1,
      pages: [
        {
          jobs: [
            { name: WORKER_CLUSTER_JOB_NAME, conclusion: "success" },
            { name: WORKER_EXECUTE_JOB_NAME, conclusion: "failure" },
          ],
        },
      ],
    },
    {
      attempt: 2,
      pages: [
        {
          jobs: [
            { name: WORKER_EXECUTE_JOB_NAME, conclusion: "success" },
            { name: WORKER_PUBLISH_JOB_NAME, conclusion: "success" },
          ],
        },
      ],
    },
  ];

  assert.deepEqual(
    resolveWorkerPublicationCohort({
      artifactPages,
      jobInventories,
      runId: 9000,
      currentAttempt: 2,
      workerLedgersRequired: true,
    }),
    {
      resultArtifact: {
        id: 103,
        name: "clawsweeper-repair-9000-2",
        attempt: 2,
      },
      clusterJob: { attempt: 1, result: "success" },
      executeJob: { attempt: 2, result: "success" },
      publishJob: { attempt: 2, result: "success" },
      clusterLedger: {
        id: 102,
        name: "clawsweeper-repair-worker-action-ledger-cluster-9000-1",
        attempt: 1,
      },
      executeLedger: {
        id: 104,
        name: "clawsweeper-repair-worker-action-ledger-execute-9000-2",
        attempt: 2,
      },
      publishLedger: {
        id: 105,
        name: "clawsweeper-repair-worker-action-ledger-publish-9000-2",
        attempt: 2,
      },
    },
  );
});

test("publication cohort accepts a skipped publish job without a publish ledger", () => {
  const cohort = resolveWorkerPublicationCohort({
    artifactPages: [
      {
        artifacts: [
          artifact(201, "clawsweeper-repair-worker-9001-1"),
          artifact(202, "clawsweeper-repair-worker-action-ledger-cluster-9001-1"),
          artifact(203, "clawsweeper-repair-worker-action-ledger-execute-9001-1"),
        ],
      },
    ],
    jobInventories: [
      {
        attempt: 1,
        pages: [
          {
            jobs: [
              { name: WORKER_CLUSTER_JOB_NAME, conclusion: "success" },
              { name: WORKER_EXECUTE_JOB_NAME, conclusion: "success" },
              { name: WORKER_PUBLISH_JOB_NAME, conclusion: "skipped" },
            ],
          },
        ],
      },
    ],
    runId: 9001,
    currentAttempt: 1,
    workerLedgersRequired: true,
  });

  assert.deepEqual(cohort.publishJob, { attempt: 1, result: "skipped" });
  assert.equal(cohort.publishLedger, null);
});

function workflowJobName(workflow: string, jobId: string): string {
  const match = new RegExp(`^  ${jobId}:\\n    name: ([^\\n]+)$`, "m").exec(workflow);
  assert.ok(match, `worker workflow is missing the ${jobId} job name`);
  return match[1]!;
}

function artifact(id: number, name: string, expired = false) {
  return { id, name, expired };
}
