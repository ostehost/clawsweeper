export type {
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

export { ISSUES_QUERY, PROJECTS_QUERY, TEAMS_QUERY } from "./queries.js";

export { createLinearTransport, resolveLinearToken } from "./client.js";
export type { LinearTransport, LinearTransportOptions, ResolveTokenOptions } from "./client.js";

export { LinearItemSource } from "./source.js";

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
