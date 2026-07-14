import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const referenceRoots = [".github", "docs"];
const appTokenRef =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0";
const privilegedActionFiles = [
  ".github/workflows/repair-comment-router.yml",
  ".github/workflows/sweep.yml",
  ".github/workflows/commit-review.yml",
  ".github/workflows/repair-cluster-worker.yml",
  ".github/actions/setup-state/action.yml",
  ".github/actions/setup-pnpm/action.yml",
  ".github/actions/setup-codex/action.yml",
];
const approvedActionPins = new Map([
  ["actions/cache", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"],
  ["actions/checkout", "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"],
  ["actions/create-github-app-token", "bcd2ba49218906704ab6c1aa796996da409d3eb1"],
  ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
  ["actions/setup-node", "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
  ["oven-sh/setup-bun", "0c5077e51419868618aeaa5fe8019c62421857d6"],
]);

function referenceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return referenceFiles(path);
    return /\.(?:md|ya?ml)$/.test(entry.name) ? [path] : [];
  });
}

test("GitHub App token creation uses the approved immutable action pin everywhere", () => {
  const references = referenceRoots.flatMap(referenceFiles).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("actions/create-github-app-token@"))
      .map((line) => ({ path, reference: line.trim().replace(/^uses:\s*/, "") })),
  );

  assert.ok(references.length > 0, "expected GitHub App token action references");
  assert.deepEqual(
    [...new Set(references.map(({ reference }) => reference))],
    [appTokenRef],
    references.map(({ path, reference }) => `${path}: ${reference}`).join("\n"),
  );
});

test("privileged workflows and composite actions use approved immutable action pins", () => {
  const references = privilegedActionFiles.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*-?\s*uses:\s*([^\s#]+)@([^\s#]+)/.exec(line);
        return match && !match[1]?.startsWith("./")
          ? [{ path, action: match[1]!, revision: match[2]! }]
          : [];
      }),
  );

  assert.ok(references.length > 0, "expected external action references");
  for (const { path, action, revision } of references) {
    assert.equal(revision, approvedActionPins.get(action), `${path}: ${action}@${revision}`);
    assert.match(revision, /^[0-9a-f]{40}$/, `${path}: ${action}@${revision}`);
  }
});

test("cache actions use one runtime generation everywhere", () => {
  const references = referenceRoots.flatMap(referenceFiles).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => line.match(/actions\/cache(?:\/(?:restore|save))?@v\d+/g) ?? []),
  );

  assert.deepEqual([...new Set(references)].sort(), ["actions/cache@v6"]);
});
