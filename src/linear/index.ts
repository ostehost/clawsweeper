export type {
  HydratedWorkspaceItem,
  LinearConnection,
  LinearIssue,
  LinearLabel,
  LinearPageInfo,
  LinearProject,
  LinearTeam,
  ListIssuesOptions,
  WorkspaceItem,
  WorkspaceSweepOptions,
} from "./types.js";

export {
  LinearRequestError,
  linearRetryKind,
  linearRetryWaitMs,
  shouldRetryLinear,
} from "./retry.js";
export type { LinearRetryKind } from "./retry.js";

export { ISSUE_BY_IDENTIFIER_QUERY, ISSUES_QUERY, PROJECTS_QUERY, TEAMS_QUERY } from "./queries.js";

export { createLinearTransport, mintLinearAppToken, resolveLinearToken } from "./client.js";
export type {
  LinearTransport,
  LinearTransportOptions,
  MintAppTokenOptions,
  MintedAppToken,
  ResolveTokenOptions,
} from "./client.js";

export { LinearItemSource, parseLinearIdentifier } from "./source.js";
export type { ParsedIdentifier } from "./source.js";

export type {
  ItemCategory,
  LinearRecordValidationIssue,
  LinearReviewRecord,
  LinearSourceProvider,
  TrackerItemState,
  TriagePriority,
} from "./record.js";

export {
  assertLinearReviewRecord,
  inferItemCategory,
  isStaleIssue,
  LINEAR_SOURCE_PROVIDER,
  linearRecordPath,
  linearReviewMarker,
  linearReviewSnapshotHash,
  linearWorkspaceSlug,
  mapLinearPriority,
  mapLinearState,
  mapWorkspaceItem,
  validateLinearReviewRecord,
} from "./record.js";

export type {
  ClassifierOptions,
  CloseCandidateReason,
  LinearClassification,
  ReviewDisposition,
} from "./classifier.js";

export { classifyRecord, classifyRecords, proposesClose } from "./classifier.js";

export type {
  CloseConfidence,
  CloseDecision,
  CloseEvidence,
  CloseReason,
  DriftFingerprint,
  LabelChange,
  MutationAuthorization,
  MutationGates,
  MutationKind,
  MutationReceipt,
  MutationRequest,
} from "./authority.js";

export {
  authorizeMutation,
  authorizeMutations,
  buildMutationReceipt,
  EVIDENCE_CLOSE_REASONS,
  gateForKind,
  mergeLabels,
  resolveGates,
  REVIEW_ONLY_GATES,
} from "./authority.js";

export type {
  LinearComment,
  ReviewCommentAction,
  ReviewCommentPlan,
  ReviewCommentUpsertInput,
} from "./comment.js";

export {
  COMMENT_CREATE_MUTATION,
  COMMENT_UPDATE_MUTATION,
  findReviewComments,
  hasReviewMarker,
  planReviewCommentUpsert,
  renderReviewCommentBody,
  reviewCommentMutationRequest,
} from "./comment.js";

export type {
  CronTriggerOptions,
  CronTriggerSpec,
  OnDemandHandle,
  RunExpectations,
  RunOutcome,
  RunSentinel,
  RunSentinels,
  RunVerdict,
} from "./trigger.js";

export {
  DEFAULT_MAX_RUN_AGE_MS,
  DEFAULT_SEMANTIC_FAILURE_PATTERNS,
  detectSentinel,
  evaluateRunExpectations,
  HUB_OPENCLAW_ROOT,
  HUB_USER,
  onDemandTriggerHandle,
  TRIAGE_ALERT_SENTINEL,
  TRIAGE_OK_SENTINEL,
  TRIAGE_SCRIPT_REL,
  triageRunExpectations,
  weeklyTriageCronSpec,
  WEEKLY_TRIAGE_CRON,
  WEEKLY_TRIAGE_TZ,
} from "./trigger.js";
