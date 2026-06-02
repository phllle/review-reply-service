import { test } from "node:test";
import assert from "node:assert/strict";
import { processQueuedReplies } from "../src/auto.js";

const queuedRow = {
  id: 123,
  accountId: "acct-1",
  locationId: "loc-1",
  reviewId: "review-1",
  generatedReply: "Thanks for the review."
};

test("processQueuedReplies posts through the row-lock send helper", async () => {
  const replyCalls = [];
  const handled = [];
  const database = {
    useDb: () => true,
    getPendingRepliesDueToSend: async () => [queuedRow],
    sendPendingReplyWithLock: async (id, sendReply) => {
      assert.equal(id, queuedRow.id);
      await sendReply(queuedRow);
      return queuedRow;
    },
    markPendingReplyError: async () => assert.fail("should not mark successful sends as errors")
  };

  const result = await processQueuedReplies(console, {
    db: database,
    replyToReview: async (...args) => replyCalls.push(args),
    addRepliedReviewId: async (...args) => handled.push(args)
  });

  assert.deepEqual(replyCalls, [
    [queuedRow.accountId, queuedRow.locationId, queuedRow.reviewId, queuedRow.generatedReply]
  ]);
  assert.deepEqual(handled, [[queuedRow.accountId, queuedRow.locationId, queuedRow.reviewId]]);
  assert.deepEqual(result, { processed: 1, failed: 0 });
});

test("processQueuedReplies skips rows that are no longer open when locked", async () => {
  const database = {
    useDb: () => true,
    getPendingRepliesDueToSend: async () => [queuedRow],
    sendPendingReplyWithLock: async () => null,
    markPendingReplyError: async () => assert.fail("skipped rows are not send failures")
  };

  const result = await processQueuedReplies(console, {
    db: database,
    replyToReview: async () => assert.fail("cancelled rows must not be posted"),
    addRepliedReviewId: async () => assert.fail("cancelled rows must not be marked handled")
  });

  assert.deepEqual(result, { processed: 0, failed: 0 });
});
