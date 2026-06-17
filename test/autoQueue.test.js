import { test } from "node:test";
import assert from "node:assert/strict";

const { processQueuedReplies } = await import("../src/auto.js");

function pendingReply(overrides = {}) {
  return {
    id: "pending-1",
    accountId: "acct-1",
    locationId: "loc-1",
    reviewId: "review-1",
    generatedReply: "Thanks for the feedback.",
    ...overrides
  };
}

test("processQueuedReplies claims due replies before posting so concurrent workers do not double-send", async () => {
  let claimed = false;
  const posts = [];
  const sentIds = [];
  const repliedReviews = [];
  const store = {
    useDb: () => true,
    async claimPendingRepliesDueToSend() {
      if (claimed) return [];
      claimed = true;
      return [pendingReply()];
    },
    async markPendingReplySent(id) {
      sentIds.push(id);
    }
  };
  const deps = {
    db: store,
    async replyToReview(accountId, locationId, reviewId, comment) {
      posts.push({ accountId, locationId, reviewId, comment });
    },
    async addRepliedReviewId(accountId, locationId, reviewId) {
      repliedReviews.push({ accountId, locationId, reviewId });
    }
  };

  const [first, second] = await Promise.all([
    processQueuedReplies(console, deps),
    processQueuedReplies(console, deps)
  ]);

  assert.equal(first.processed + second.processed, 1);
  assert.equal(posts.length, 1);
  assert.deepEqual(sentIds, ["pending-1"]);
  assert.deepEqual(repliedReviews, [{ accountId: "acct-1", locationId: "loc-1", reviewId: "review-1" }]);
});

test("processQueuedReplies releases a failed claim for retry by marking the row errored", async () => {
  const errors = [];
  const store = {
    useDb: () => true,
    async claimPendingRepliesDueToSend() {
      return [pendingReply()];
    },
    async markPendingReplySent() {
      assert.fail("failed posts must not be marked sent");
    },
    async markPendingReplyError(id, message) {
      errors.push({ id, message });
    }
  };
  const logger = {
    error() {}
  };

  const result = await processQueuedReplies(logger, {
    db: store,
    async replyToReview() {
      throw new Error("google outage");
    },
    async addRepliedReviewId() {
      assert.fail("failed posts must not be recorded as replied");
    }
  });

  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(errors, [{ id: "pending-1", message: "google outage" }]);
});
