import assert from "node:assert/strict";
import test from "node:test";

import {
  githubLimitedPagePath,
  githubPaginatedPath,
  ghSpawnMutationOutcome,
} from "../../dist/repair/github-cli.js";

test("githubPaginatedPath requests maximum REST page size by default", () => {
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues/123/comments"),
    "repos/openclaw/openclaw/issues/123/comments?per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?state=open&sort=created"),
    "repos/openclaw/openclaw/issues?state=open&sort=created&per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?per_page=50&state=open"),
    "repos/openclaw/openclaw/issues?per_page=50&state=open",
  );
});

test("githubLimitedPagePath caps one REST page and preserves existing filters", () => {
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 80),
    "repos/openclaw/openclaw/pulls/123/files?per_page=80&page=1",
  );
  assert.equal(
    githubLimitedPagePath(
      "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100",
      250,
      3,
    ),
    "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100&page=3",
  );
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 0, 0),
    "repos/openclaw/openclaw/pulls/123/files?per_page=1&page=1",
  );
});

test("ghSpawnMutationOutcome distinguishes rejection from ambiguous transport", () => {
  const result = (overrides: {
    status?: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
    stdout?: string;
    stderr?: string;
  }) => ({
    status: overrides.status ?? null,
    signal: overrides.signal ?? null,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    ...(overrides.error ? { error: overrides.error } : {}),
  });

  assert.equal(ghSpawnMutationOutcome(result({ status: 0 })), "accepted");
  assert.equal(
    ghSpawnMutationOutcome(result({ status: 1, stderr: "HTTP 422: validation failed" })),
    "rejected",
  );
  assert.equal(
    ghSpawnMutationOutcome(result({ status: 1, stderr: "HTTP 502: bad gateway" })),
    "unknown",
  );
  assert.equal(
    ghSpawnMutationOutcome(result({ status: 1, stderr: "unexpected GitHub CLI failure" })),
    "unknown",
  );
  assert.equal(ghSpawnMutationOutcome(result({ status: null, signal: "SIGTERM" })), "unknown");
  assert.equal(
    ghSpawnMutationOutcome(
      result({
        error: Object.assign(new Error("spawn gh ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
    ),
    "unknown",
  );
  assert.equal(
    ghSpawnMutationOutcome(
      result({ error: Object.assign(new Error("spawn gh EIO"), { code: "EIO" }) }),
    ),
    "unknown",
  );
  assert.equal(
    ghSpawnMutationOutcome(
      result({ error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) }),
    ),
    "rejected",
  );
});
