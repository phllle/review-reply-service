import { test } from "node:test";
import assert from "node:assert/strict";
import { processQueuedRepliesWithDeps } from "../src/auto.js";

function logger() {
  return {
    error() {}
  };
}

function baseDeps(overrides = {}) {
  return {
    useDb: () => true,
    claimPendingRepliesDueToSend: async () => [],
    replyToReview: async () => {},
    markPendingReplySent: async () => {},
    markPendingReplyError: async () => {},
    addRepliedReviewId: async () => {},
    ...overrides
  };
}

const queuedReply = {
  id: 123,
  accountId: "accounts/1",
  locationId: "locations/2",
  reviewId: "reviews/3",
  generatedReply: "Thanks for the feedback."
};

test("processQueuedRepliesWithDeps claims due rows before posting", async () => {
  const calls = [];
  const deps = baseDeps({
    claimPendingRepliesDueToSend: async () => {
      calls.push("claim");
      return [queuedReply];
    },
    replyToReview: async (accountId, locationId, reviewId, comment) => {
      calls.push(["reply", accountId, locationId, reviewId, comment]);
    },
    markPendingReplySent: async (id) => {
      calls.push(["sent", id]);
    },
    addRepliedReviewId: async (accountId, locationId, reviewId) => {
      calls.push(["state", accountId, locationId, reviewId]);
    }
  });

  const result = await processQueuedRepliesWithDeps(deps, logger());

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(calls, [
    "claim",
    ["reply", "accounts/1", "locations/2", "reviews/3", "Thanks for the feedback."],
    ["sent", 123],
    ["state", "accounts/1", "locations/2", "reviews/3"]
  ]);
});

test("processQueuedRepliesWithDeps does not claim rows when DB storage is disabled", async () => {
  let claimed = false;
  const deps = baseDeps({
    useDb: () => false,
    claimPendingRepliesDueToSend: async () => {
      claimed = true;
      return [queuedReply];
    }
  });

  const result = await processQueuedRepliesWithDeps(deps, logger());

  assert.deepEqual(result, { processed: 0 });
  assert.equal(claimed, false);
});

test("processQueuedRepliesWithDeps releases a claimed row for retry when posting fails", async () => {
  const errors = [];
  const deps = baseDeps({
    claimPendingRepliesDueToSend: async () => [queuedReply],
    replyToReview: async () => {
      throw new Error("google unavailable");
    },
    markPendingReplyError: async (id, message) => {
      errors.push([id, message]);
    }
  });

  const result = await processQueuedRepliesWithDeps(deps, logger());

  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(errors, [[123, "google unavailable"]]);
});
