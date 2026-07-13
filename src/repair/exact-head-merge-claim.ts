import type { LooseRecord } from "./json-types.js";

const CLAIM_PREFIX = "clawsweeper-exact-head-merge-claim:v1";
const CLAIM_PATTERN =
  /<!-- clawsweeper-exact-head-merge-claim:v1 repo=([^ ]+) pr=([1-9][0-9]*) head=([a-fA-F0-9]{40}) method=([a-z]+) owner=([a-z0-9_-]+) claimant=([^ ]+) -->/g;

export type ExactHeadMergeClaimIdentity = {
  repository: string;
  number: number;
  headSha: string;
  method: "squash";
};

export type ExactHeadMergeClaimRequest = ExactHeadMergeClaimIdentity & {
  owner: string;
  claimant: string;
  appId: number;
  appSlug: string;
};

export type ExactHeadMergeClaimResult =
  | { status: "acquired"; reason: ""; claimId: number }
  | { status: "existing"; reason: string; claimId: number }
  | { status: "blocked" | "unknown"; reason: string; claimId: null };

export type ExactHeadMergeClaimInspection =
  | { status: "absent"; reason: ""; claimId: null }
  | Exclude<ExactHeadMergeClaimResult, { status: "acquired" }>;

type ParsedClaim = ExactHeadMergeClaimIdentity & {
  owner: string;
  claimant: string;
};

type TrustedClaim = {
  comment: LooseRecord;
  id: number;
  claim: ParsedClaim;
};

export function exactHeadMergeClaimant(
  owner: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalizedOwner = normalizeOwner(owner);
  const runId = String(env.GITHUB_RUN_ID ?? "").trim();
  const runAttempt = String(env.GITHUB_RUN_ATTEMPT ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error("workflow identity is invalid for the exact-head merge claim");
  }
  return `${normalizedOwner}:${runId}:${runAttempt}`;
}

export function exactHeadMergeClaimIdentity(
  request: ExactHeadMergeClaimIdentity,
): ExactHeadMergeClaimIdentity {
  return normalizeIdentity(request);
}

export function exactHeadMergeClaimBody(request: ExactHeadMergeClaimRequest): string {
  const normalized = normalizeRequest(request);
  return [
    exactHeadMergeClaimMarker(normalized),
    `ClawSweeper reserved the exact-head squash merge request for \`${normalized.headSha.slice(0, 12)}\`. Later workflow attempts will only reconcile GitHub state and will not issue the merge again.`,
  ].join("\n");
}

export function isTrustedExactHeadMergeClaimComment(
  comment: LooseRecord,
  request: ExactHeadMergeClaimRequest,
): boolean {
  const normalized = normalizeRequest(request);
  if (!trustedClaimAuthor(comment, normalized)) return false;
  const body = String(comment.body ?? "");
  const claims = parseClaimMarkers(body);
  return (
    claimPrefixCount(body) === 1 &&
    claims.length === 1 &&
    sameClaim(claims[0]!, normalized) &&
    claims[0]!.owner === normalized.owner &&
    claims[0]!.claimant === normalized.claimant
  );
}

export function ensureExactHeadMergeClaim(
  request: ExactHeadMergeClaimRequest,
  io: {
    listComments: () => LooseRecord[];
    createComment: (body: string) => LooseRecord;
  },
): ExactHeadMergeClaimResult {
  const normalized = normalizeRequest(request);
  const marker = exactHeadMergeClaimMarker(normalized);
  const initial = inspectExactHeadMergeClaim(normalized, io.listComments);
  if (initial.status !== "absent") return initial;

  let createError = "";
  try {
    io.createComment(exactHeadMergeClaimBody(normalized));
  } catch (error) {
    createError = errorText(error);
  }

  const confirmed = inspectClaims(normalized, io.listComments);
  if ("failure" in confirmed) return confirmed.failure;
  if (confirmed.exact.length === 0) {
    return {
      status: "unknown",
      reason: `exact-head merge claim outcome could not be confirmed${createError ? `: ${createError}` : ""}`,
      claimId: null,
    };
  }

  const ownClaims = confirmed.exact.filter((claim) =>
    String(claim.comment.body ?? "").includes(marker),
  );
  const winningClaim = confirmed.exact.reduce((winner, claim) =>
    claim.id < winner.id ? claim : winner,
  );
  if (ownClaims.some((claim) => claim.id === winningClaim.id)) {
    return { status: "acquired", reason: "", claimId: winningClaim.id };
  }
  return {
    status: "existing",
    reason: "another verified workflow owns the exact-head merge claim; reconciliation only",
    claimId: winningClaim.id,
  };
}

export function inspectExactHeadMergeClaim(
  request: ExactHeadMergeClaimRequest,
  listComments: () => LooseRecord[],
): ExactHeadMergeClaimInspection {
  const normalized = normalizeRequest(request);
  const inspected = inspectClaims(normalized, listComments);
  if ("failure" in inspected) return inspected.failure;
  if (inspected.exact.length === 0) return { status: "absent", reason: "", claimId: null };
  return {
    status: "existing",
    reason: "exact-head merge request is durably claimed; reconciliation only",
    claimId: inspected.exact[0]!.id,
  };
}

function inspectClaims(
  request: ExactHeadMergeClaimRequest,
  listComments: () => LooseRecord[],
):
  | { exact: TrustedClaim[] }
  | { failure: Extract<ExactHeadMergeClaimResult, { status: "blocked" | "unknown" }> } {
  let comments: LooseRecord[];
  try {
    comments = listComments();
  } catch (error) {
    return {
      failure: {
        status: "unknown",
        reason: `exact-head merge claim state could not be read: ${errorText(error)}`,
        claimId: null,
      },
    };
  }
  if (!Array.isArray(comments)) {
    return {
      failure: {
        status: "unknown",
        reason: "exact-head merge claim comments response is invalid",
        claimId: null,
      },
    };
  }

  const exact: TrustedClaim[] = [];
  for (const comment of comments) {
    if (!trustedClaimAuthor(comment, request)) continue;
    const body = String(comment.body ?? "");
    if (!body.includes(CLAIM_PREFIX)) continue;
    const markers = parseClaimMarkers(body);
    if (claimPrefixCount(body) !== 1 || markers.length !== 1) {
      return {
        failure: {
          status: "blocked",
          reason: "trusted exact-head merge claim marker is malformed or duplicated",
          claimId: null,
        },
      };
    }
    const id = commentId(comment);
    if (!id) {
      return {
        failure: {
          status: "blocked",
          reason: "trusted exact-head merge claim is missing an immutable comment id",
          claimId: null,
        },
      };
    }
    const claim = markers[0]!;
    if (!sameClaim(claim, request)) {
      return {
        failure: {
          status: "blocked",
          reason: `conflicting durable merge claim exists for ${claim.repository}#${claim.number} at ${claim.headSha}`,
          claimId: null,
        },
      };
    }
    exact.push({ comment, id, claim });
  }
  exact.sort((left, right) => left.id - right.id);
  return { exact };
}

function exactHeadMergeClaimMarker(request: ExactHeadMergeClaimRequest): string {
  return `<!-- ${CLAIM_PREFIX} repo=${encodeURIComponent(request.repository)} pr=${request.number} head=${request.headSha} method=${request.method} owner=${request.owner} claimant=${encodeURIComponent(request.claimant)} -->`;
}

function parseClaimMarkers(body: string): ParsedClaim[] {
  const claims: ParsedClaim[] = [];
  for (const match of body.matchAll(CLAIM_PATTERN)) {
    try {
      claims.push({
        repository: normalizeRepository(decodeURIComponent(match[1]!)),
        number: normalizeNumber(Number(match[2])),
        headSha: normalizeHeadSha(match[3]!),
        method: normalizeMethod(match[4]!),
        owner: normalizeOwner(match[5]!),
        claimant: normalizeClaimant(decodeURIComponent(match[6]!)),
      });
    } catch {
      return [];
    }
  }
  return claims;
}

function claimPrefixCount(body: string): number {
  return body.split(CLAIM_PREFIX).length - 1;
}

function normalizeRequest(request: ExactHeadMergeClaimRequest): ExactHeadMergeClaimRequest {
  const identity = normalizeIdentity(request);
  const appId = Number(request.appId);
  const appSlug = String(request.appSlug ?? "")
    .trim()
    .toLowerCase();
  if (!Number.isSafeInteger(appId) || appId < 1) {
    throw new Error("authenticated GitHub App id is invalid for the exact-head merge claim");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(appSlug)) {
    throw new Error("authenticated GitHub App slug is invalid for the exact-head merge claim");
  }
  return {
    ...identity,
    owner: normalizeOwner(request.owner),
    claimant: normalizeClaimant(request.claimant),
    appId,
    appSlug,
  };
}

function normalizeIdentity(request: ExactHeadMergeClaimIdentity): ExactHeadMergeClaimIdentity {
  return {
    repository: normalizeRepository(request.repository),
    number: normalizeNumber(request.number),
    headSha: normalizeHeadSha(request.headSha),
    method: normalizeMethod(request.method),
  };
}

function normalizeRepository(value: string): string {
  const repository = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository is invalid for the exact-head merge claim");
  }
  return repository;
}

function normalizeNumber(value: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("pull request number is invalid for the exact-head merge claim");
  }
  return number;
}

function normalizeHeadSha(value: string): string {
  const headSha = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    throw new Error("head SHA is invalid for the exact-head merge claim");
  }
  return headSha;
}

function normalizeMethod(value: string): "squash" {
  if (
    String(value ?? "")
      .trim()
      .toLowerCase() !== "squash"
  ) {
    throw new Error("merge method is invalid for the exact-head merge claim");
  }
  return "squash";
}

function normalizeOwner(value: string): string {
  const owner = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(owner)) {
    throw new Error("owner is invalid for the exact-head merge claim");
  }
  return owner;
}

function normalizeClaimant(value: string): string {
  const claimant = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.:-]{0,159}$/.test(claimant)) {
    throw new Error("claimant is invalid for the exact-head merge claim");
  }
  return claimant;
}

function trustedClaimAuthor(comment: LooseRecord, request: ExactHeadMergeClaimRequest): boolean {
  const app = comment.performed_via_github_app;
  if (
    !app ||
    Number(app.id) !== request.appId ||
    String(app.slug ?? "")
      .trim()
      .toLowerCase() !== request.appSlug
  ) {
    return false;
  }
  const login = String(comment.user?.login ?? "")
    .trim()
    .toLowerCase();
  return login === `${request.appSlug}[bot]`;
}

function sameClaim(left: ExactHeadMergeClaimIdentity, right: ExactHeadMergeClaimIdentity): boolean {
  return (
    left.repository === right.repository &&
    left.number === right.number &&
    left.headSha === right.headSha &&
    left.method === right.method
  );
}

function commentId(comment: LooseRecord): number | null {
  const id = Number(comment.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
