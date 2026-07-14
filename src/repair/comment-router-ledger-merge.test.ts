import assert from "node:assert/strict";
import test from "node:test";

import { mergeCommentRouterLedgerJson } from "./comment-router-ledger-merge.js";

test("comment router ledger merge unions disjoint compact commands", () => {
  const base = ledger([command("base", "2026-07-13T10:00:00Z")]);
  const local = ledger([
    command("base", "2026-07-13T10:00:00Z"),
    command("local", "2026-07-13T10:01:00Z"),
  ]);
  const remote = ledger([
    command("base", "2026-07-13T10:00:00Z"),
    command("remote", "2026-07-13T10:02:00Z"),
  ]);

  assert.deepEqual(
    commandKeys(
      mergeCommentRouterLedgerJson({ baseText: base, localText: local, remoteText: remote }),
    ),
    ["base:2026-07-13T10:00:00Z", "local:2026-07-13T10:01:00Z", "remote:2026-07-13T10:02:00Z"],
  );
});

test("comment router ledger merge keeps unresolved receipts across deletion and ambiguous terminals", () => {
  const attempted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "attempted",
  });
  const accepted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "accepted",
  });
  const terminal = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "executed",
    receipt: "accepted",
  });

  const deletionMerge = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([attempted]),
      localText: ledger([]),
      remoteText: ledger([attempted]),
    }),
  );
  assert.equal(receiptStatus(deletionMerge.commands[0]), "attempted");

  const concurrentMerge = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([attempted]),
      localText: ledger([terminal]),
      remoteText: ledger([accepted]),
    }),
  );
  assert.equal(concurrentMerge.commands[0].status, "waiting");
  assert.equal(receiptStatus(concurrentMerge.commands[0]), "accepted");
});

test("comment router ledger merge keeps an unproven same-receipt terminal behind the barrier", () => {
  const attempted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "attempted",
  });
  const terminal = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "skipped",
    receipt: "attempted",
  });
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([attempted]),
      localText: ledger([terminal]),
      remoteText: ledger([attempted]),
    }),
  );

  assert.equal(merged.commands[0].status, "waiting");
  assert.equal(receiptStatus(merged.commands[0]), "attempted");
});

test("comment router ledger merge keeps accepted and unknown blocked confirmations unresolved", () => {
  for (const receipt of ["accepted", "unknown"]) {
    const barrier = command(`merge-${receipt}`, "2026-07-13T10:00:00Z", {
      commandStatus: "waiting",
      actionStatus: "waiting",
      receipt,
    });
    const blocked = command(`merge-${receipt}`, "2026-07-13T10:00:00Z", {
      commandStatus: "executed",
      actionStatus: "blocked",
      receipt,
    });
    const merged = parse(
      mergeCommentRouterLedgerJson({
        baseText: ledger([barrier]),
        localText: ledger([blocked]),
        remoteText: ledger([barrier]),
      }),
    );

    assert.equal(merged.commands[0].status, "waiting", receipt);
    assert.equal(receiptStatus(merged.commands[0]), receipt);
  }
});

test("comment router ledger merge accepts only identity-bound confirmed merge resolutions", () => {
  const cases = [
    { barrier: "attempted", resolution: "attempted", actionStatus: "skipped" },
    { barrier: "attempted", resolution: "unknown", actionStatus: "skipped" },
    { barrier: "unknown", resolution: "unknown", actionStatus: "skipped" },
    { barrier: "attempted", resolution: "accepted", actionStatus: "executed" },
    { barrier: "accepted", resolution: "accepted", actionStatus: "executed" },
  ];
  for (const [index, item] of cases.entries()) {
    const key = `confirmed-${index}`;
    const barrier = command(key, "2026-07-13T10:00:00Z", {
      commandStatus: "waiting",
      actionStatus: "waiting",
      receipt: item.barrier,
    });
    const resolution = command(key, "2026-07-13T10:00:00Z", {
      commandStatus: "executed",
      actionStatus: item.actionStatus,
      receipt: item.resolution,
      confirmed: true,
    });
    const merged = parse(
      mergeCommentRouterLedgerJson({
        baseText: ledger([barrier]),
        localText: ledger([resolution]),
        remoteText: ledger([barrier]),
      }),
    );

    assert.equal(merged.commands[0].status, "executed", JSON.stringify(item));
    assert.equal(receiptStatus(merged.commands[0]), item.resolution);
  }
});

test("comment router ledger merge terminalizes only causally confirmed unmerged receipts", () => {
  const causalCases = [
    { barrier: "attempted", resolution: "attempted" },
    { barrier: "attempted", resolution: "accepted" },
    { barrier: "attempted", resolution: "unknown" },
    { barrier: "accepted", resolution: "accepted" },
    { barrier: "unknown", resolution: "unknown" },
  ];
  for (const [index, item] of causalCases.entries()) {
    const key = `confirmed-unmerged-${index}`;
    const barrier = command(key, "2026-07-13T10:00:00Z", {
      commandStatus: "waiting",
      actionStatus: "waiting",
      receipt: item.barrier,
    });
    const resolution = command(key, "2026-07-13T10:00:00Z", {
      commandStatus: "executed",
      actionStatus: "skipped",
      receipt: item.resolution,
      confirmedUnmerged: true,
    });
    const merged = parse(
      mergeCommentRouterLedgerJson({
        baseText: ledger([barrier]),
        localText: ledger([resolution]),
        remoteText: ledger([barrier]),
      }),
    );

    assert.equal(merged.commands[0].status, "executed", JSON.stringify(item));
    assert.equal(receiptStatus(merged.commands[0]), item.resolution);
  }

  const invalid = command("invalid-unmerged", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "skipped",
    receipt: "unknown",
    confirmedUnmerged: true,
  });
  const invalidAction = invalid.actions?.[0];
  assert.ok(invalidAction);
  invalidAction.live_graphql_state = "OPEN";
  const barrier = command("invalid-unmerged", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "unknown",
  });
  const retained = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([barrier]),
      localText: ledger([invalid]),
      remoteText: ledger([barrier]),
    }),
  );
  assert.equal(retained.commands[0].status, "waiting");
});

test("comment router ledger merge rejects noncausal unmerged receipt rewrites", () => {
  for (const [barrierReceipt, resolutionReceipt] of [
    ["accepted", "unknown"],
    ["unknown", "accepted"],
  ] as const) {
    const key = `noncausal-${barrierReceipt}-${resolutionReceipt}`;
    const barrier = command(key, "2026-07-13T10:00:00Z", {
      commandStatus: "waiting",
      actionStatus: "waiting",
      receipt: barrierReceipt,
    });
    const resolution = command(key, "2026-07-13T10:00:00Z", {
      commandStatus: "executed",
      actionStatus: "skipped",
      receipt: resolutionReceipt,
      confirmedUnmerged: true,
    });
    const merged = parse(
      mergeCommentRouterLedgerJson({
        baseText: ledger([barrier]),
        localText: ledger([resolution]),
        remoteText: ledger([barrier]),
      }),
    );
    assert.equal(merged.commands[0].status, "waiting");
    assert.equal(receiptStatus(merged.commands[0]), barrierReceipt);
  }
});

test("comment router ledger merge rejects malformed confirmed-merge identity evidence", () => {
  const barrier = command("malformed-proof", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "accepted",
  });
  const malformed = command("malformed-proof", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "executed",
    receipt: "accepted",
    confirmed: true,
  });
  const malformedAction = malformed.actions?.[0];
  assert.ok(malformedAction);
  malformedAction.merge_commit_sha = "not-a-commit";
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([barrier]),
      localText: ledger([malformed]),
      remoteText: ledger([barrier]),
    }),
  );

  assert.equal(merged.commands[0].status, "waiting");
  assert.equal(receiptStatus(merged.commands[0]), "accepted");
});

test("comment router ledger merge permits a causal attempted-to-rejected transition", () => {
  const attempted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "attempted",
  });
  const rejected = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "blocked",
    receipt: "rejected",
  });
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([attempted]),
      localText: ledger([rejected]),
      remoteText: ledger([attempted]),
    }),
  );

  assert.equal(merged.commands[0].status, "executed");
  assert.equal(receiptStatus(merged.commands[0]), "rejected");
});

test("comment router ledger merge does not rewrite an accepted barrier as rejected", () => {
  const accepted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "accepted",
  });
  const rejected = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "blocked",
    receipt: "rejected",
  });
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([accepted]),
      localText: ledger([rejected]),
      remoteText: ledger([accepted]),
    }),
  );

  assert.equal(merged.commands[0].status, "waiting");
  assert.equal(receiptStatus(merged.commands[0]), "accepted");
});

test("comment router ledger merge does not infer causality from a later wall clock", () => {
  const attempted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "attempted",
  });
  const concurrentTerminal = {
    ...command("merge", "2026-07-13T10:01:00Z", {
      commandStatus: "executed",
      actionStatus: "executed",
      receipt: "accepted",
    }),
    comment_version_key: attempted.comment_version_key,
    comment_updated_at: attempted.comment_updated_at,
  };
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([]),
      localText: ledger([attempted]),
      remoteText: ledger([concurrentTerminal]),
    }),
  );

  assert.equal(merged.commands[0].status, "waiting");
  assert.equal(receiptStatus(merged.commands[0]), "attempted");
});

test("comment router ledger merge does not clear a barrier with a skipped replay marker", () => {
  const attempted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "attempted",
  });
  const skipped = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "skipped",
    actionStatus: "skipped",
    receipt: "unknown",
  });
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([attempted]),
      localText: ledger([skipped]),
      remoteText: ledger([attempted]),
    }),
  );

  assert.equal(merged.commands[0].status, "waiting");
  assert.equal(receiptStatus(merged.commands[0]), "attempted");
});

test("comment router ledger merge fails closed on conflicting expected heads", () => {
  const first = {
    ...command("merge", "2026-07-13T10:00:00Z", {
      commandStatus: "waiting",
      actionStatus: "waiting",
      receipt: "attempted",
    }),
    expected_head_sha: "a".repeat(40),
  };
  const second = { ...first, expected_head_sha: "b".repeat(40) };

  assert.throws(
    () =>
      mergeCommentRouterLedgerJson({
        baseText: ledger([]),
        localText: ledger([first]),
        remoteText: ledger([second]),
      }),
    /conflicting expected head SHAs/,
  );
});

test("comment router ledger merge allows non-merge target snapshots to drift", () => {
  const first = {
    ...command("status", "2026-07-13T10:00:00Z"),
    target: { head_sha: "a".repeat(40) },
  };
  const second = {
    ...command("status", "2026-07-13T10:01:00Z"),
    comment_version_key: first.comment_version_key,
    comment_updated_at: first.comment_updated_at,
    target: { head_sha: "b".repeat(40) },
  };
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([]),
      localText: ledger([first]),
      remoteText: ledger([second]),
    }),
  );

  assert.equal(merged.commands[0].target.head_sha, "b".repeat(40));
});

test("comment router ledger merge keeps an executed command over a later concurrent claim", () => {
  const executed = command("dispatch", "2026-07-13T10:00:00Z");
  const claimed = {
    ...command("dispatch", "2026-07-13T10:01:00Z", { commandStatus: "claimed" }),
    comment_version_key: executed.comment_version_key,
    comment_updated_at: executed.comment_updated_at,
  };
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([]),
      localText: ledger([executed]),
      remoteText: ledger([claimed]),
    }),
  );

  assert.equal(merged.commands[0].status, "executed");
});

test("comment router ledger merge preserves a dispatch claim across compacting deletion", () => {
  const claim = {
    ...command("dispatch-claim", "2026-07-13T10:00:00Z", { commandStatus: "claimed" }),
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([claim]),
      localText: ledger([claim]),
      remoteText: ledger([]),
    }),
  );

  assert.equal(merged.commands[0].status, "claimed");
  assert.equal(merged.commands[0].idempotency_key, claim.idempotency_key);
});

test("comment router ledger merge keeps accepted proof over a concurrent rejection", () => {
  const accepted = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "executed",
    receipt: "accepted",
  });
  const rejected = command("merge", "2026-07-13T10:00:00Z", {
    commandStatus: "executed",
    actionStatus: "blocked",
    receipt: "rejected",
  });
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([]),
      localText: ledger([accepted]),
      remoteText: ledger([rejected]),
    }),
  );

  assert.equal(receiptStatus(merged.commands[0]), "accepted");
});

test("comment router ledger merge pins unresolved receipts before trimming ordinary history", () => {
  const ordinary = Array.from({ length: 1_000 }, (_, index) =>
    command(
      `ordinary-${index}`,
      `2026-07-13T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    ),
  );
  const unresolved = command("old-merge", "2026-07-13T09:00:00Z", {
    commandStatus: "waiting",
    actionStatus: "waiting",
    receipt: "unknown",
  });
  const merged = parse(
    mergeCommentRouterLedgerJson({
      baseText: ledger([]),
      localText: ledger(ordinary),
      remoteText: ledger([unresolved]),
    }),
  );

  assert.equal(merged.commands.length, 1_000);
  assert.equal(
    merged.commands.some((entry: { comment_id?: string }) => entry.comment_id === "old-merge"),
    true,
  );
  assert.equal(
    merged.commands.some((entry: { comment_id?: string }) => entry.comment_id === "ordinary-0"),
    false,
  );
});

test("comment router ledger merge rejects a dispatch claim beyond protected capacity", () => {
  const unresolved = Array.from({ length: 1_000 }, (_, index) =>
    command(`unresolved-${index}`, new Date(Date.UTC(2026, 6, 13, 9, 0, index)).toISOString(), {
      commandStatus: "waiting",
      actionStatus: "waiting",
      receipt: "unknown",
    }),
  );
  const claim = {
    ...command("new-dispatch", "2026-07-13T11:00:00Z", { commandStatus: "claimed" }),
    intent: "re_review",
    actions: [{ action: "dispatch_clawsweeper", status: "claimed" }],
  };

  assert.throws(
    () =>
      mergeCommentRouterLedgerJson({
        baseText: ledger(unresolved),
        localText: ledger(unresolved),
        remoteText: ledger([claim]),
      }),
    /too many protected mutation receipts/,
  );
});

test("comment router ledger merge fails closed on duplicate durable keys", () => {
  const duplicate = command("duplicate", "2026-07-13T10:00:00Z");
  assert.throws(
    () =>
      mergeCommentRouterLedgerJson({
        baseText: ledger([]),
        localText: ledger([duplicate, duplicate]),
        remoteText: ledger([]),
      }),
    /duplicate command key/,
  );
});

function command(
  key: string,
  processedAt: string,
  options: {
    commandStatus?: string;
    actionStatus?: string;
    receipt?: string;
    confirmed?: boolean;
    confirmedUnmerged?: boolean;
  } = {},
) {
  const commandStatus = options.commandStatus ?? "executed";
  return {
    idempotency_key: `router:${key}`,
    comment_id: key,
    comment_version_key: `${key}:${processedAt}`,
    comment_updated_at: processedAt,
    repo: "openclaw/openclaw",
    issue_number: 42,
    intent: "clawsweeper_auto_merge",
    ...(options.receipt ? { expected_head_sha: "a".repeat(40) } : {}),
    status: commandStatus,
    processed_at: processedAt,
    ...(options.receipt
      ? {
          actions: [
            {
              action: "merge",
              status: options.actionStatus ?? commandStatus,
              label: null,
              job_path: null,
              merge_mutation_status: options.receipt,
              ...(options.confirmed
                ? {
                    merged_at: "2026-07-13T10:05:00Z",
                    merge_commit_sha: "b".repeat(40),
                    prepared_head_sha: "a".repeat(40),
                  }
                : {}),
              ...(options.confirmedUnmerged
                ? {
                    confirmation_status: "confirmed_unmerged",
                    live_rest_state: "closed",
                    live_graphql_state: "CLOSED",
                  }
                : {}),
            },
          ],
        }
      : {}),
  };
}

function ledger(commands: unknown[]): string {
  return `${JSON.stringify({ updated_at: "2026-07-13T12:00:00Z", commands }, null, 2)}\n`;
}

function parse(text: string) {
  return JSON.parse(text);
}

function commandKeys(text: string): string[] {
  return parse(text).commands.map(
    (entry: { comment_version_key: string }) => entry.comment_version_key,
  );
}

function receiptStatus(command: { actions?: { merge_mutation_status?: string }[] }): string | null {
  return (
    command.actions?.find((action) => action.merge_mutation_status)?.merge_mutation_status ?? null
  );
}
