import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWorkerPublicationCohort,
  selectLatestAttemptArtifact,
  selectLatestJobResult,
} from "../../src/repair/workflow-attempt-cohort.ts";

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
            { name: "Plan and review cluster", conclusion: "success" },
            { name: "Execute and apply cluster actions", conclusion: "failure" },
          ],
        },
      ],
    },
    {
      attempt: 2,
      pages: [
        {
          jobs: [{ name: "Execute and apply cluster actions", conclusion: "success" }],
        },
      ],
    },
  ];

  assert.deepEqual(selectLatestJobResult(inventories, "Plan and review cluster", 2), {
    attempt: 1,
    result: "success",
  });
  assert.deepEqual(selectLatestJobResult(inventories, "Execute and apply cluster actions", 2), {
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
      ],
    },
  ];
  const jobInventories = [
    {
      attempt: 1,
      pages: [
        {
          jobs: [
            { name: "Plan and review cluster", conclusion: "success" },
            { name: "Execute and apply cluster actions", conclusion: "failure" },
          ],
        },
      ],
    },
    {
      attempt: 2,
      pages: [
        {
          jobs: [{ name: "Execute and apply cluster actions", conclusion: "success" }],
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
    },
  );
});

function artifact(id: number, name: string, expired = false) {
  return { id, name, expired };
}
