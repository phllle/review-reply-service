import { test } from "node:test";
import assert from "node:assert/strict";
import { processQueuedReplies } from "../src/auto.js";

function makeStore(rows) {
  const calls = {
    sent: [],
    skipped: [],
    errors: []
  };
  return {
    calls,
    useDb() {
      return true;
    },
    async claimPendingRepliesDueToSend() {
      return rows;
    },
    async markPendingReplySent(id) {
      calls.sent.push(id);
      return true;
    },
    async markPendingReplySkipped(id, reason) {
      calls.skipped.push({ id, reason });
      return true;
    },
    async markPendingReplyError(id, message) {
      calls.errors.push({ id, message });
    }
  };
}

const row = {
  id: 101,
  accountId: "acct-1",
  locationId: "loc-1",
  reviewId: "rev-1",
  generatedReply: "Thanks for the feedback"
};

test("processQueuedReplies posts claimed rows and marks them sent", async () => {
  const store = makeStore([row]);
  const posted = [];
  const handled = [];

  const result = await processQueuedReplies(console, {
    db: store,
    async listReviews() {
      return [{ reviewId: "rev-1" }];
    },
    async replyToReview(accountId, locationId, reviewId, comment) {
      posted.push({ accountId, locationId, reviewId, comment });
    },
    async addRepliedReviewId(accountId, locationId, reviewId) {
      handled.push({ accountId, locationId, reviewId });
    }
  });

  assert.deepEqual(result, { processed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(posted, [
    {
      accountId: "acct-1",
      locationId: "loc-1",
      reviewId: "rev-1",
      comment: "Thanks for the feedback"
    }
  ]);
  assert.deepEqual(store.calls.sent, [101]);
  assert.deepEqual(handled, [{ accountId: "acct-1", locationId: "loc-1", reviewId: "rev-1" }]);
});

test("processQueuedReplies skips a queued row when Google already has a reply", async () => {
  const store = makeStore([row]);
  const posted = [];

  const result = await processQueuedReplies(console, {
    db: store,
    async listReviews() {
      return [
        {
          name: "accounts/acct-1/locations/loc-1/reviews/rev-1",
          reviewReply: { comment: "Manual reply" }
        }
      ];
    },
    async replyToReview() {
      posted.push("posted");
    },
    async addRepliedReviewId() {}
  });

  assert.deepEqual(result, { processed: 0, failed: 0, skipped: 1 });
  assert.deepEqual(posted, []);
  assert.deepEqual(store.calls.sent, []);
  assert.equal(store.calls.skipped.length, 1);
  assert.equal(store.calls.skipped[0].id, 101);
});

test("processQueuedReplies releases claimed rows when posting fails", async () => {
  const store = makeStore([row]);

  const result = await processQueuedReplies({ error() {} }, {
    db: store,
    async listReviews() {
      return [{ reviewId: "rev-1" }];
    },
    async replyToReview() {
      throw new Error("google unavailable");
    },
    async addRepliedReviewId() {}
  });

  assert.deepEqual(result, { processed: 0, failed: 1, skipped: 0 });
  assert.deepEqual(store.calls.sent, []);
  assert.equal(store.calls.errors.length, 1);
  assert.equal(store.calls.errors[0].id, 101);
  assert.match(store.calls.errors[0].message, /google unavailable/);
});
