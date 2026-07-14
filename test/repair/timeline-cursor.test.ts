import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewedTimelineCursor,
  reviewedTimelineTail,
} from "../../dist/repair/timeline-cursor.js";

test("reviewed timeline cursors reject same-second foreign activity", () => {
  const reviewed = [
    {
      id: 10,
      event: "commented",
      created_at: "2026-07-13T08:00:00Z",
      body: "reviewed comment",
    },
  ];
  const cursor = createReviewedTimelineCursor(reviewed);
  const claim = {
    id: 11,
    event: "commented",
    created_at: "2026-07-13T08:00:00Z",
  };

  assert.deepEqual(reviewedTimelineTail(cursor, [...reviewed, claim], new Set([11])), [claim]);
  assert.equal(
    reviewedTimelineTail(
      cursor,
      [
        ...reviewed,
        {
          id: 12,
          event: "labeled",
          created_at: "2026-07-13T08:00:00Z",
        },
        claim,
      ],
      new Set([11]),
    ),
    null,
  );
});

test("reviewed timeline cursors reject edits and reordered prefixes", () => {
  const reviewed = [
    { id: 20, event: "commented", body: "first" },
    { id: 21, event: "labeled", label: { name: "ready" } },
  ];
  const cursor = createReviewedTimelineCursor(reviewed);

  assert.equal(
    reviewedTimelineTail(cursor, [
      { ...reviewed[0], body: "edited in the same second" },
      reviewed[1]!,
    ]),
    null,
  );
  assert.equal(reviewedTimelineTail(cursor, [reviewed[1]!, reviewed[0]!]), null);
});
