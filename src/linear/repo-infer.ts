/**
 * Linear → target_repo inference (pure, offline, conservative).
 *
 * Doctrine — infer ONLY the target_repo STRING; never guess, never default:
 *   The analysis runner must map a Linear issue to a known target repository before it can
 *   point the read-only Codex sandbox at the right local checkout. This helper infers ONLY the
 *   `owner/repo` string from the issue's labels, title, and attachment/body URLs. It NEVER
 *   resolves a checkout dir (that is repositoryProfileFor().checkoutDir, called downstream),
 *   NEVER falls back to DEFAULT_TARGET_REPO, and returns AMBIGUOUS (no repo) whenever it
 *   cannot pick exactly one — the runner then SKIPS analysis rather than analyzing the wrong
 *   tree. Pure: no network, no clock, no filesystem.
 *
 * Precedence, first-hit wins:
 *   (1) An explicit GitHub URL in the attachments or body — owner/repo via the canonicalRef
 *       regex (schema line 389). A single unique owner/repo across all URLs wins outright.
 *       Two or more DISTINCT owner/repo URLs → AMBIGUOUS.
 *   (2) A label naming a known target_repo / checkout_dir / display_name from
 *       config/target-repositories.json (case-insensitive). One unique survivor wins.
 *   (3) A label or title owner token in the generic-fallback owners (e.g. openclaw, steipete)
 *       paired with a repo name that passes allow_repo_name_pattern. One unique survivor wins.
 *   Step-1 yields 0 URLs and >=2 distinct surviving candidates, OR 0 candidates → AMBIGUOUS.
 */

import { normalizeRepo, REPOSITORY_PROFILES } from "../repository-profiles.js";

/** The known-repo facts this helper matches against (extracted from the profiles + config). */
export interface RepoCatalogEntry {
  targetRepo: string; // normalized "owner/repo"
  checkoutDir: string;
  displayName: string;
}

/** Generic-fallback owner rule (owner token + repo-name allow pattern). */
export interface FallbackOwnerRule {
  owner: string; // lowercased
  allowRepoNamePattern: RegExp;
}

/** The catalog the inference reads — built from the static profiles + config fallbacks. */
export interface RepoCatalog {
  entries: RepoCatalogEntry[];
  fallbackOwners: FallbackOwnerRule[];
}

/** A Linear item's repo-bearing surfaces (plain data; no fetch). */
export interface RepoInferenceItem {
  labels: string[];
  title: string;
  /** Attachment/body URLs (e.g. attachment.url values + URLs scraped from the description). */
  urls: string[];
}

export type RepoInference =
  | { repo: string; via: "url" | "label" | "fallback-owner"; reasons: string[] }
  | { repo: null; ambiguous: true; reasons: string[] };

// Mirror schema/clawsweeper-decision.schema.json canonicalRef (line 389), relaxed to also
// accept a bare owner/repo path and an optional trailing /issues|/pull/<n>.
const GITHUB_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:issues|pull)\/[1-9][0-9]*)?(?:[/#?].*)?$/i;

/** Extracts distinct normalized owner/repo strings from a list of URLs. */
export function ownerRepoFromUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = (raw ?? "").trim();
    if (url === "") continue;
    const match = GITHUB_URL_RE.exec(url);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    const repo = normalizeRepo(`${match[1]}/${match[2]}`);
    if (!seen.has(repo)) {
      seen.add(repo);
      out.push(repo);
    }
  }
  return out;
}

/**
 * Builds the inference catalog from the static REPOSITORY_PROFILES plus generic-fallback owner
 * rules. Callers normally pass `fallbackOwners` read from config/target-repositories.json's
 * generic_fallbacks; tests pass fakes. Pure.
 */
export function buildRepoCatalog(fallbackOwners: FallbackOwnerRule[] = []): RepoCatalog {
  const entries: RepoCatalogEntry[] = REPOSITORY_PROFILES.map((p) => ({
    targetRepo: normalizeRepo(p.targetRepo),
    checkoutDir: p.checkoutDir.toLowerCase(),
    displayName: p.displayName.toLowerCase(),
  }));
  return {
    entries,
    fallbackOwners: fallbackOwners.map((f) => ({ ...f, owner: f.owner.toLowerCase() })),
  };
}

function distinctSurvivors(repos: string[]): string[] {
  return [...new Set(repos.map((r) => normalizeRepo(r)))];
}

// Step 2 — labels naming a known target_repo / checkout_dir / display_name.
function matchKnownByLabel(item: RepoInferenceItem, catalog: RepoCatalog): string[] {
  const tokens = item.labels.map((l) => l.trim().toLowerCase()).filter((l) => l !== "");
  const hits: string[] = [];
  for (const entry of catalog.entries) {
    if (
      tokens.includes(entry.targetRepo) ||
      tokens.includes(entry.checkoutDir) ||
      tokens.includes(entry.displayName)
    ) {
      hits.push(entry.targetRepo);
    }
  }
  return hits;
}

// Step 3 — a fallback-owner token (label or title word) + a repo-name candidate that passes
// the owner's allow pattern. The repo-name candidate is taken from labels of the form
// "owner/name" or a label that is a plain safe name paired with a present owner token.
function matchByFallbackOwner(item: RepoInferenceItem, catalog: RepoCatalog): string[] {
  if (catalog.fallbackOwners.length === 0) return [];
  const titleTokens = item.title
    .toLowerCase()
    .split(/[^A-Za-z0-9_.-]+/)
    .filter((t) => t !== "");
  const labelTokens = item.labels.map((l) => l.trim().toLowerCase()).filter((l) => l !== "");
  const tokens = new Set([...titleTokens, ...labelTokens]);
  const hits: string[] = [];

  for (const rule of catalog.fallbackOwners) {
    if (!tokens.has(rule.owner)) continue;
    for (const label of labelTokens) {
      const slash = label.indexOf("/");
      if (slash > 0) {
        const owner = label.slice(0, slash);
        const name = label.slice(slash + 1);
        if (owner === rule.owner && rule.allowRepoNamePattern.test(name)) {
          hits.push(normalizeRepo(`${rule.owner}/${name}`));
        }
        continue;
      }
      if (label !== rule.owner && rule.allowRepoNamePattern.test(label)) {
        hits.push(normalizeRepo(`${rule.owner}/${label}`));
      }
    }
  }
  return hits;
}

/**
 * Infers the target_repo string. Precedence: URL → known-label → fallback-owner. Returns a
 * single repo or AMBIGUOUS (repo:null). Never guesses, never defaults. The runner must SKIP
 * analysis on AMBIGUOUS (and never call repositoryProfileFor, which throws on an unknown repo).
 */
export function inferTargetRepo(item: RepoInferenceItem, catalog: RepoCatalog): RepoInference {
  const reasons: string[] = [];

  // (1) Explicit GitHub URL — a single unique owner/repo wins outright.
  const urlRepos = ownerRepoFromUrls(item.urls);
  if (urlRepos.length === 1) {
    return {
      repo: urlRepos[0] as string,
      via: "url",
      reasons: [`unique GitHub URL → ${urlRepos[0]}`],
    };
  }
  if (urlRepos.length >= 2) {
    return {
      repo: null,
      ambiguous: true,
      reasons: [`>=2 distinct GitHub URLs [${urlRepos.join(", ")}] — ambiguous, skip`],
    };
  }
  reasons.push("no GitHub URL in attachments/body");

  // (2) Label naming a known target_repo / checkout_dir / display_name.
  const labelHits = distinctSurvivors(matchKnownByLabel(item, catalog));
  if (labelHits.length === 1) {
    return {
      repo: labelHits[0] as string,
      via: "label",
      reasons: [...reasons, `known-repo label → ${labelHits[0]}`],
    };
  }
  if (labelHits.length >= 2) {
    return {
      repo: null,
      ambiguous: true,
      reasons: [...reasons, `>=2 known-repo labels [${labelHits.join(", ")}] — ambiguous, skip`],
    };
  }

  // (3) Fallback-owner token + allowed repo-name.
  const fallbackHits = distinctSurvivors(matchByFallbackOwner(item, catalog));
  if (fallbackHits.length === 1) {
    return {
      repo: fallbackHits[0] as string,
      via: "fallback-owner",
      reasons: [...reasons, `fallback-owner candidate → ${fallbackHits[0]}`],
    };
  }
  if (fallbackHits.length >= 2) {
    return {
      repo: null,
      ambiguous: true,
      reasons: [
        ...reasons,
        `>=2 fallback-owner candidates [${fallbackHits.join(", ")}] — ambiguous, skip`,
      ],
    };
  }

  return { repo: null, ambiguous: true, reasons: [...reasons, "0 candidates — ambiguous, skip"] };
}
