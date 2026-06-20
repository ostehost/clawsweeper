/**
 * Linear → ClawSweeper record mapping (deterministic, offline, pure functions).
 *
 * Priority mapping:
 *   Linear 0 (none)   → "none"
 *   Linear 1 (urgent) → "P1"
 *   Linear 2 (high)   → "P2"
 *   Linear 3 (medium) → "P3"
 *   Linear 4 (low)    → "P3"
 *   Any other value   → "none"
 *
 *   P0 is intentionally never assigned here. ClawSweeper reserves P0 exclusively for
 *   emergencies (data loss, security bypass, crash loop, unusable core runtime) requiring
 *   concrete impact evidence that this deterministic mapping layer cannot establish from a
 *   priority integer alone. Linear's "urgent" (1) maps to P1 ("urgent regression affecting
 *   real users now"), which is the correct conservative match. Mapping urgent→P0 would
 *   over-escalate and break ClawSweeper's evidence-required doctrine. P0 is never assigned
 *   from the tracker priority field alone.
 *
 * State mapping:
 *   Linear stateType "completed" or "canceled" → "closed"
 *   Anything else (backlog, unstarted, started, null) → "open"
 *
 * Category inference: case-insensitive substring match on label names.
 *   Precedence (first match wins):
 *   security > regression > bug > docs > skill > cleanup > support > admin > feature
 *   No match → "unclear"
 *
 * Staleness: updatedAt is compared against a caller-supplied nowIso string.
 *   Default stale threshold is 60 days. No system clock reads (deterministic).
 */

import type { LinearIssue, LinearLabel, LinearTeam, WorkspaceItem } from "./types.js";

export type TrackerItemState = "open" | "closed";

export type TriagePriority = "P0" | "P1" | "P2" | "P3" | "none";

export type ItemCategory =
  | "bug"
  | "regression"
  | "feature"
  | "skill"
  | "docs"
  | "cleanup"
  | "support"
  | "admin"
  | "security"
  | "unclear";

export interface LinearReviewRecord {
  key: string; // = issue.identifier, e.g. "PAR-123"
  title: string;
  url: string;
  workspaceSlug: string; // "linear-" + team.key.toLowerCase()
  recordPath: string; // `records/<workspaceSlug>/items/<key>.md`
  reviewMarker: string; // `<!-- clawsweeper-review:<key> -->`
  state: TrackerItemState;
  triagePriority: TriagePriority;
  itemCategory: ItemCategory;
  teamKey: string;
  teamName: string;
  projectName: string | null;
  labels: string[]; // label NAMES, from issue.labels[].name
  createdAt: string;
  updatedAt: string;
}

/** Returns the workspace slug: "linear-" + team.key lowercased. */
export function linearWorkspaceSlug(team: LinearTeam): string {
  return `linear-${team.key.toLowerCase()}`;
}

/** Returns the record path for an issue given a workspace slug and issue key. */
export function linearRecordPath(workspaceSlug: string, key: string): string {
  return `records/${workspaceSlug}/items/${key}.md`;
}

/** Returns the durable review-comment marker for a given issue key. */
export function linearReviewMarker(key: string): string {
  return `<!-- clawsweeper-review:${key} -->`;
}

/**
 * Maps a Linear priority integer to a TriagePriority.
 * 0 → none, 1 → P1, 2 → P2, 3 → P3, 4 → P3, else → none.
 * P0 is never assigned here — see module doc comment for rationale.
 */
export function mapLinearPriority(priority: number): TriagePriority {
  switch (priority) {
    case 1:
      return "P1";
    case 2:
      return "P2";
    case 3:
      return "P3";
    case 4:
      return "P3";
    default:
      return "none";
  }
}

/**
 * Maps a Linear state type to TrackerItemState.
 * "completed" or "canceled" → "closed"; everything else (including null) → "open".
 */
export function mapLinearState(stateType: string | null): TrackerItemState {
  if (stateType === "completed" || stateType === "canceled") return "closed";
  return "open";
}

// Category precedence order — first substring match wins.
const CATEGORY_RULES: Array<[ItemCategory, string]> = [
  ["security", "security"],
  ["regression", "regression"],
  ["bug", "bug"],
  ["docs", "doc"],
  ["skill", "skill"],
  ["cleanup", "cleanup"],
  ["support", "support"],
  ["admin", "admin"],
  ["feature", "feature"],
];

/**
 * Infers an ItemCategory from label names via case-insensitive substring match.
 * Precedence: security > regression > bug > docs > skill > cleanup > support > admin > feature.
 * Returns "unclear" when no label matches.
 */
export function inferItemCategory(labels: LinearLabel[]): ItemCategory {
  const names = labels.map((l) => l.name.toLowerCase());
  for (const [category, substr] of CATEGORY_RULES) {
    if (names.some((n) => n.includes(substr))) return category;
  }
  return "unclear";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 60;

/**
 * Returns true if the issue's updatedAt is older than staleDays before nowIso.
 * nowIso must be provided by the caller — this function never reads the system clock.
 */
export function isStaleIssue(
  issue: LinearIssue,
  nowIso: string,
  staleDays = DEFAULT_STALE_DAYS,
): boolean {
  const now = new Date(nowIso).getTime();
  const updated = new Date(issue.updatedAt).getTime();
  return now - updated > staleDays * MS_PER_DAY;
}

/**
 * Maps a WorkspaceItem (team + project + issue) into a LinearReviewRecord.
 * Aggregates all mapping helpers above.
 */
export function mapWorkspaceItem(item: WorkspaceItem): LinearReviewRecord {
  const { team, project, issue } = item;
  const key = issue.identifier;
  const workspaceSlug = linearWorkspaceSlug(team);
  return {
    key,
    title: issue.title,
    url: issue.url,
    workspaceSlug,
    recordPath: linearRecordPath(workspaceSlug, key),
    reviewMarker: linearReviewMarker(key),
    state: mapLinearState(issue.stateType),
    triagePriority: mapLinearPriority(issue.priority),
    itemCategory: inferItemCategory(issue.labels),
    teamKey: team.key,
    teamName: team.name,
    projectName: project?.name ?? null,
    labels: issue.labels.map((l) => l.name),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}
