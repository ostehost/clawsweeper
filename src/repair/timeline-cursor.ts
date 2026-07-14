import { createHash } from "node:crypto";
import { stableJson } from "../stable-json.js";
import type { LooseRecord } from "./json-types.js";

export const MAX_REVIEWED_TIMELINE_EVENTS = 1_000;

const CURSOR_PATTERN = /^v1:([0-9]+):([0-9a-f]{64})$/;

export function createReviewedTimelineCursor(timeline: LooseRecord[]): string {
  if (!Array.isArray(timeline) || timeline.length > MAX_REVIEWED_TIMELINE_EVENTS) {
    throw new Error("reviewed timeline exceeds the bounded cursor limit");
  }
  return `v1:${timeline.length}:${timelineDigest(timeline)}`;
}

export function reviewedTimelineTail(
  cursor: unknown,
  timeline: LooseRecord[],
  allowedTailIds: ReadonlySet<number> = new Set(),
): LooseRecord[] | null {
  const match = String(cursor ?? "").match(CURSOR_PATTERN);
  if (!match || !Array.isArray(timeline)) return null;
  const reviewedCount = Number(match[1]);
  if (
    !Number.isSafeInteger(reviewedCount) ||
    reviewedCount < 0 ||
    reviewedCount > MAX_REVIEWED_TIMELINE_EVENTS ||
    timeline.length < reviewedCount
  ) {
    return null;
  }
  if (timelineDigest(timeline.slice(0, reviewedCount)) !== match[2]) return null;
  const tail = timeline.slice(reviewedCount);
  for (const event of tail) {
    const id = Number(event.id);
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !allowedTailIds.has(id) ||
      String(event.event ?? "") !== "commented"
    ) {
      return null;
    }
  }
  return tail;
}

function timelineDigest(timeline: LooseRecord[]): string {
  return createHash("sha256").update(stableJson(timeline)).digest("hex");
}
