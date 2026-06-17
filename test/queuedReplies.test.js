import { test } from "node:test";
import assert from "node:assert/strict";
import { processQueuedReplies } from "../src/auto.js";

const dueRow = {
  id: "pending-1",
  accountId: "acct-1",
  locationId: "loc-1",
  reviewId: "review-1",
  generatedReply: "Thanks for visiting"
};

test("processQueuedReplies skips a due row when the send claim is no longer available", async () => {
  let postCalls = 0;
  let addHandledCalls = 0;
  let markErrorCalls = 0;

  const result = await processQueuedReplies(console, {
    db: {
      useDb: () => true,
      getPendingRepliesDueToSend: async () => [dueRow],
      withPendingReplySendClaim: async () => null,
      markPendingReplyError: async () => {
        markErrorCalls += 1;
      }
    },
    replyToReview: async () => {
      postCalls += 1;
    },
    addRepliedReviewId: async () => {
      addHandledCalls += 1;
    }
  });

  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.equal(postCalls, 0);
  assert.equal(addHandledCalls, 0);
  assert.equal(markErrorCalls, 0);
});

test("processQueuedReplies posts through the send claim before marking the review handled", async () => {
  const events = [];

  const result = await processQueuedReplies(console, {
    db: {
      useDb: () => true,
      getPendingRepliesDueToSend: async () => [dueRow],
      withPendingReplySendClaim: async (id, sendReply) => {
        assert.equal(id, dueRow.id);
        events.push("claim:start");
        await sendReply(dueRow);
        events.push("claim:after-post");
        return { ...dueRow, sentAt: "2026-06-05T11:00:00.000Z" };
      },
      markPendingReplyError: async () => {
        events.push("mark-error");
      }
    },
    replyToReview: async (accountId, locationId, reviewId, generatedReply) => {
      events.push(`post:${reviewId}`);
      assert.equal(accountId, dueRow.accountId);
      assert.equal(locationId, dueRow.locationId);
      assert.equal(generatedReply, dueRow.generatedReply);
    },
    addRepliedReviewId: async (accountId, locationId, reviewId) => {
      events.push(`add-handled:${reviewId}`);
      assert.equal(accountId, dueRow.accountId);
      assert.equal(locationId, dueRow.locationId);
    }
  });

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(events, ["claim:start", "post:review-1", "claim:after-post", "add-handled:review-1"]);
});

test("processQueuedReplies records an error when posting inside the claim fails", async () => {
  const errors = [];

  const result = await processQueuedReplies(
    { error: () => {} },
    {
      db: {
        useDb: () => true,
        getPendingRepliesDueToSend: async () => [dueRow],
        withPendingReplySendClaim: async (id, sendReply) => {
          assert.equal(id, dueRow.id);
          await sendReply(dueRow);
        },
        markPendingReplyError: async (id, message) => {
          errors.push({ id, message });
        }
      },
      replyToReview: async () => {
        throw new Error("google unavailable");
      },
      addRepliedReviewId: async () => {
        throw new Error("should not mark handled");
      }
    }
  );

  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(errors, [{ id: dueRow.id, message: "google unavailable" }]);
});
