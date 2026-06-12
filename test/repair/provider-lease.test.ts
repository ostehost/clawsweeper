import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireProviderLease,
  providerLeasePath,
  readProviderLeaseDocument,
  releaseProviderLease,
  releaseProviderLeaseDocument,
  renewProviderLease,
  renewProviderLeaseDocument,
  safeProviderName,
  tryAcquireProviderLease,
  writeProviderLeaseDocument,
} from "../../dist/repair/provider-lease.js";

test("provider lease acquisition respects weighted capacity", () => {
  const now = new Date("2026-06-12T00:00:00Z");
  const document = {
    provider: "codex-internal-default",
    capacity: 4,
    updatedAt: now.toISOString(),
    leases: [lease("a", 2, "2026-06-12T00:10:00Z"), lease("b", 1, "2026-06-12T00:10:00Z")],
  };

  const blocked = tryAcquireProviderLease(document, {
    leaseId: "c",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/openclaw#1",
    runId: "1",
    weight: 2,
    ttlMs: 900_000,
    now,
  });

  assert.equal(blocked.result.acquired, false);
  assert.equal(blocked.result.activeWeight, 3);
  assert.equal(blocked.result.capacity, 4);
  assert.match(blocked.result.reason ?? "", /provider capacity full/);

  const acquired = tryAcquireProviderLease(document, {
    leaseId: "c",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/openclaw#1",
    runId: "1",
    weight: 1,
    ttlMs: 900_000,
    now,
  });

  assert.equal(acquired.result.acquired, true);
  assert.equal(acquired.document.leases.length, 3);
  assert.equal(acquired.result.lease?.expiresAt, "2026-06-12T00:15:00.000Z");
});

test("provider lease acquisition prunes expired leases", () => {
  const now = new Date("2026-06-12T00:00:00Z");
  const acquired = tryAcquireProviderLease(
    {
      provider: "codex-internal-default",
      capacity: 1,
      updatedAt: now.toISOString(),
      leases: [lease("expired", 1, "2026-06-11T23:59:00Z")],
    },
    {
      leaseId: "fresh",
      owner: "openclaw/clawsweeper",
      lane: "exact-review",
      item: "openclaw/openclaw#2",
      runId: "2",
      weight: 1,
      ttlMs: 900_000,
      now,
    },
  );

  assert.equal(acquired.result.acquired, true);
  assert.deepEqual(
    acquired.document.leases.map((entry) => entry.id),
    ["fresh"],
  );
});

test("provider lease release removes only the requested lease", () => {
  const now = new Date("2026-06-12T00:00:00Z");
  const result = releaseProviderLeaseDocument(
    {
      provider: "codex-internal-default",
      capacity: 4,
      updatedAt: now.toISOString(),
      leases: [lease("keep", 1, "2026-06-12T00:10:00Z"), lease("drop", 1, "2026-06-12T00:10:00Z")],
    },
    "drop",
    now,
  );

  assert.equal(result.released, true);
  assert.deepEqual(
    result.document.leases.map((entry) => entry.id),
    ["keep"],
  );
});

test("provider lease renew extends only an active requested lease", () => {
  const now = new Date("2026-06-12T00:00:00Z");
  const renewed = renewProviderLeaseDocument(
    {
      provider: "codex-internal-default",
      capacity: 4,
      updatedAt: now.toISOString(),
      leases: [lease("keep", 1, "2026-06-12T00:01:00Z")],
    },
    "keep",
    900_000,
    now,
  );

  assert.equal(renewed.renewed, true);
  assert.equal(renewed.lease?.acquiredAt, "2026-06-12T00:00:00Z");
  assert.equal(renewed.lease?.expiresAt, "2026-06-12T00:15:00.000Z");

  const expired = renewProviderLeaseDocument(
    {
      provider: "codex-internal-default",
      capacity: 4,
      updatedAt: now.toISOString(),
      leases: [lease("expired", 1, "2026-06-11T23:59:00Z")],
    },
    "expired",
    900_000,
    now,
  );

  assert.equal(expired.renewed, false);
  assert.deepEqual(expired.document.leases, []);
});

test("provider lease documents round-trip in state repo layout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-provider-lease-"));
  const document = {
    provider: "codex/internal default",
    capacity: 4,
    updatedAt: "2026-06-12T00:00:00Z",
    leases: [lease("a", 1, "2026-06-12T00:10:00Z")],
  };

  writeProviderLeaseDocument(root, document);

  assert.equal(safeProviderName(document.provider), "codex-internal-default");
  assert.equal(
    providerLeasePath(root, document.provider),
    path.join(root, "provider-leases", "codex-internal-default.json"),
  );
  assert.deepEqual(readProviderLeaseDocument(root, document.provider), document);
});

test("provider lease reads use current configured capacity over stored capacity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-provider-lease-capacity-"));
  const provider = "codex-internal-default";
  fs.mkdirSync(path.dirname(providerLeasePath(root, provider)), { recursive: true });
  fs.writeFileSync(
    providerLeasePath(root, provider),
    `${JSON.stringify({
      provider,
      capacity: 10,
      updatedAt: "2026-06-12T00:00:00Z",
      leases: [],
    })}\n`,
    "utf8",
  );

  assert.equal(readProviderLeaseDocument(root, provider, 2).capacity, 2);
});

test("provider lease acquisition fails when push is rejected", () => {
  const origin = seedStateOrigin();
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-provider-lease-checkout-"));

  const hook = path.join(origin, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
  fs.chmodSync(hook, 0o755);

  git(["clone", "--branch", "state", origin, checkout]);

  assert.throws(
    () =>
      acquireProviderLease({
        stateDir: checkout,
        provider: "codex-internal-default",
        leaseId: "rejected-push",
        owner: "openclaw/clawsweeper",
        lane: "exact-review",
        item: "openclaw/openclaw#3",
        runId: "3",
        capacity: 1,
        weight: 1,
        ttlMs: 900_000,
        waitMs: 0,
        pollMs: 1,
      }),
    /shared state push failed/,
  );
});

test("provider lease shared state gates timeout release and ttl recovery", async () => {
  const origin = seedStateOrigin();
  const first = cloneStateOrigin(origin);
  const second = cloneStateOrigin(origin);
  const provider = "codex-internal-default";

  const acquired = acquireProviderLease({
    stateDir: first,
    provider,
    leaseId: "capacity-holder",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#281",
    runId: "capacity-holder",
    capacity: 1,
    weight: 1,
    ttlMs: 60_000,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(acquired.acquired, true);
  assert.equal(acquired.activeWeight, 1);

  const blocked = acquireProviderLease({
    stateDir: second,
    provider,
    leaseId: "capacity-waiter",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#282",
    runId: "capacity-waiter",
    capacity: 1,
    weight: 1,
    ttlMs: 60_000,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(blocked.acquired, false);
  assert.equal(blocked.activeWeight, 1);
  assert.match(blocked.reason ?? "", /provider capacity full/);

  assert.equal(
    releaseProviderLease({
      stateDir: first,
      provider,
      leaseId: "capacity-holder",
      capacity: 1,
    }),
    true,
  );

  const afterRelease = acquireProviderLease({
    stateDir: second,
    provider,
    leaseId: "capacity-after-release",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#283",
    runId: "capacity-after-release",
    capacity: 1,
    weight: 1,
    ttlMs: 60_000,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(afterRelease.acquired, true);

  const ttlHolder = cloneStateOrigin(origin);
  const ttlWaiter = cloneStateOrigin(origin);
  assert.equal(
    releaseProviderLease({
      stateDir: second,
      provider,
      leaseId: "capacity-after-release",
      capacity: 1,
    }),
    true,
  );

  const stale = acquireProviderLease({
    stateDir: ttlHolder,
    provider,
    leaseId: "ttl-holder",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#284",
    runId: "ttl-holder",
    capacity: 1,
    weight: 1,
    ttlMs: 20,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(stale.acquired, true);
  await new Promise((resolve) => setTimeout(resolve, 80));

  const recovered = acquireProviderLease({
    stateDir: ttlWaiter,
    provider,
    leaseId: "ttl-recovered",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#285",
    runId: "ttl-recovered",
    capacity: 1,
    weight: 1,
    ttlMs: 60_000,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(recovered.acquired, true);
  assert.deepEqual(
    readProviderLeaseDocument(ttlWaiter, provider, 1).leases.map((entry) => entry.id),
    ["ttl-recovered"],
  );
});

test("provider lease renewal keeps a running holder past its original ttl", async () => {
  const origin = seedStateOrigin();
  const holder = cloneStateOrigin(origin);
  const waiter = cloneStateOrigin(origin);
  const provider = "codex-internal-default";

  const acquired = acquireProviderLease({
    stateDir: holder,
    provider,
    leaseId: "renewed-holder",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#281",
    runId: "renewed-holder",
    capacity: 1,
    weight: 1,
    ttlMs: 800,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(acquired.acquired, true);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(
    renewProviderLease({
      stateDir: holder,
      provider,
      leaseId: "renewed-holder",
      capacity: 1,
      ttlMs: 1200,
    }),
    true,
  );

  await new Promise((resolve) => setTimeout(resolve, 850));
  const blocked = acquireProviderLease({
    stateDir: waiter,
    provider,
    leaseId: "blocked-by-renewal",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#282",
    runId: "blocked-by-renewal",
    capacity: 1,
    weight: 1,
    ttlMs: 60_000,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(blocked.acquired, false);
  assert.match(blocked.reason ?? "", /provider capacity full/);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const recovered = acquireProviderLease({
    stateDir: waiter,
    provider,
    leaseId: "after-renewal-stops",
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/clawsweeper#283",
    runId: "after-renewal-stops",
    capacity: 1,
    weight: 1,
    ttlMs: 60_000,
    waitMs: 0,
    pollMs: 1,
  });

  assert.equal(recovered.acquired, true);
  assert.deepEqual(
    readProviderLeaseDocument(waiter, provider, 1).leases.map((entry) => entry.id),
    ["after-renewal-stops"],
  );
});

function lease(id: string, weight: number, expiresAt: string) {
  return {
    id,
    owner: "openclaw/clawsweeper",
    lane: "exact-review",
    item: "openclaw/openclaw#1",
    runId: id,
    weight,
    acquiredAt: "2026-06-12T00:00:00Z",
    expiresAt,
  };
}

function seedStateOrigin(): string {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-provider-lease-origin-"));
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-provider-lease-seed-"));

  git(["init", "--bare", origin]);
  git(["init"], seed);
  git(["config", "user.name", "ClawSweeper Test"], seed);
  git(["config", "user.email", "clawsweeper-test@example.invalid"], seed);
  fs.writeFileSync(path.join(seed, "README.md"), "state\n", "utf8");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "seed state"], seed);
  git(["checkout", "-B", "state"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "origin", "state"], seed);

  return origin;
}

function cloneStateOrigin(origin: string): string {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-provider-lease-checkout-"));
  git(["clone", "--branch", "state", origin, checkout]);
  return checkout;
}

function git(args: string[], cwd?: string) {
  const child = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    child.status,
    0,
    `git ${args.join(" ")} failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
}
