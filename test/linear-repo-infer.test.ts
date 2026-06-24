import assert from "node:assert/strict";
import test from "node:test";

import { buildRepoCatalog, inferTargetRepo, ownerRepoFromUrls } from "../dist/linear/repo-infer.js";
import type { RepoCatalog, RepoInferenceItem } from "../dist/linear/repo-infer.js";
// Barrel wiring check.
import { inferTargetRepo as inferFromIndex } from "../dist/linear/index.js";

// The static REPOSITORY_PROFILES include openclaw/openclaw, openclaw/clawhub,
// openclaw/clawsweeper, openclaw/fs-safe. Fallback owners: openclaw, steipete.
const FALLBACKS = [
  { owner: "openclaw", allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/ },
  { owner: "steipete", allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/ },
];
const CATALOG: RepoCatalog = buildRepoCatalog(FALLBACKS);

function item(overrides: Partial<RepoInferenceItem> = {}): RepoInferenceItem {
  return { labels: [], title: "", urls: [], ...overrides };
}

// ---------------------------------------------------------------------------
// ownerRepoFromUrls
// ---------------------------------------------------------------------------

test("ownerRepoFromUrls extracts distinct normalized owner/repo from issue/pull urls", () => {
  const repos = ownerRepoFromUrls([
    "https://github.com/openclaw/clawhub/issues/12",
    "https://github.com/OpenClaw/ClawHub/pull/7",
    "https://github.com/steipete/foo",
    "not a url",
  ]);
  assert.deepEqual(repos, ["openclaw/clawhub", "steipete/foo"]);
});

// ---------------------------------------------------------------------------
// Precedence (1): a single unique GitHub URL wins outright
// ---------------------------------------------------------------------------

test("infer step1: unique GitHub URL wins outright", () => {
  const r = inferTargetRepo(
    item({ urls: ["https://github.com/openclaw/clawhub/issues/3"], labels: ["bug"] }),
    CATALOG,
  );
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "url");
});

test("infer step1: >=2 distinct GitHub URLs is ambiguous -> skip", () => {
  const r = inferTargetRepo(
    item({
      urls: [
        "https://github.com/openclaw/clawhub/issues/3",
        "https://github.com/openclaw/fs-safe/pull/9",
      ],
    }),
    CATALOG,
  );
  assert.equal(r.repo, null);
});

// ---------------------------------------------------------------------------
// Precedence (2): label naming a known target_repo / checkout_dir / display_name
// ---------------------------------------------------------------------------

test("infer step2: a known checkout_dir label resolves the repo", () => {
  const r = inferTargetRepo(item({ labels: ["clawhub"] }), CATALOG);
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "label");
});

test("infer step2: a full owner/repo label resolves the repo", () => {
  const r = inferTargetRepo(item({ labels: ["openclaw/fs-safe"] }), CATALOG);
  assert.equal(r.repo, "openclaw/fs-safe");
});

test("infer step2: two distinct known-repo labels is ambiguous -> skip", () => {
  const r = inferTargetRepo(item({ labels: ["clawhub", "fs-safe"] }), CATALOG);
  assert.equal(r.repo, null);
});

// ---------------------------------------------------------------------------
// Precedence (3): fallback-owner token + allowed repo name
// ---------------------------------------------------------------------------

test("infer step3: owner token in title + a plain repo-name label", () => {
  const r = inferTargetRepo(
    item({ title: "steipete: fix the widget", labels: ["mywidget"] }),
    CATALOG,
  );
  assert.equal(r.repo, "steipete/mywidget");
  if (r.repo !== null) assert.equal(r.via, "fallback-owner");
});

// ---------------------------------------------------------------------------
// Ambiguous: no candidates -> skip; never defaults
// ---------------------------------------------------------------------------

test("infer: no URL, no known label, no owner token -> ambiguous (never default)", () => {
  const r = inferTargetRepo(item({ labels: ["bug", "needs-triage"], title: "something" }), CATALOG);
  assert.equal(r.repo, null);
});

test("inferTargetRepo is exported from the barrel", () => {
  assert.equal(typeof inferFromIndex, "function");
});
