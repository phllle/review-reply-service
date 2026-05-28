import { test } from "node:test";
import assert from "node:assert/strict";
import { processQueuedReplies } from "../src/auto.js";

function dueRow(overrides = {}) {
  return {
    id: "pending-1",
    accountId: "acct-1",
    locationId: "loc-1",
    reviewId: "rev-1",
    generatedReply: "Thanks for the feedback.",
    ...overrides
  };
}

test("processQueuedReplies skips Google post when due row cannot be claimed", async () => {
  const calls = [];
  const mockDb = {
    useDb: () => true,
    getPendingRepliesDueToSend: async () => [dueRow()],
    claimPendingReplyForSend: async () => null,
    markPendingReplySent: async () => calls.push("sent"),
    markPendingReplyError: async () => calls.push("error")
  };

  const result = await processQueuedReplies(console, {
    db: mockDb,
    replyToReview: async () => calls.push("reply"),
    addRepliedReviewId: async () => calls.push("remember")
  });

  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.deepEqual(calls, []);
});

test("processQueuedReplies posts only after claiming the pending reply", async () => {
  const row = dueRow();
  const calls = [];
  const mockDb = {
    useDb: () => true,
    getPendingRepliesDueToSend: async () => [row],
    claimPendingReplyForSend: async (id) => {
      calls.push(["claim", id]);
      return row;
    },
    markPendingReplySent: async (id) => calls.push(["sent", id]),
    markPendingReplyError: async () => calls.push(["error"])
  };

  const result = await processQueuedReplies(console, {
    db: mockDb,
    replyToReview: async (...args) => calls.push(["reply", ...args]),
    addRepliedReviewId: async (...args) => calls.push(["remember", ...args])
  });

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(calls, [
    ["claim", "pending-1"],
    ["reply", "acct-1", "loc-1", "rev-1", "Thanks for the feedback."],
    ["sent", "pending-1"],
    ["remember", "acct-1", "loc-1", "rev-1"]
  ]);
});

test("processQueuedReplies clears the claim for retry when Google post fails", async () => {
  const row = dueRow();
  const calls = [];
  const mockDb = {
    useDb: () => true,
    getPendingRepliesDueToSend: async () => [row],
    claimPendingReplyForSend: async () => row,
    markPendingReplySent: async () => calls.push("sent"),
    markPendingReplyError: async (id, message) => calls.push(["error", id, message])
  };

  const result = await processQueuedReplies({ error() {} }, {
    db: mockDb,
    replyToReview: async () => {
      throw new Error("Google timeout");
    },
    addRepliedReviewId: async () => calls.push("remember")
  });

  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(calls, [["error", "pending-1", "Google timeout"]]);
});
