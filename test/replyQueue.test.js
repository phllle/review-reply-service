import { test } from "node:test";
import assert from "node:assert/strict";

import { processQueuedRepliesWithDeps } from "../src/auto.js";

function queuedRow(overrides = {}) {
  return {
    id: 42,
    accountId: "acct-1",
    locationId: "loc-1",
    reviewId: "review-1",
    generatedReply: "Thanks for your feedback.",
    ...overrides
  };
}

test("processQueuedReplies claims due rows before posting", async () => {
  const calls = [];
  const row = queuedRow();
  const fakeDb = {
    useDb: () => true,
    claimPendingRepliesDueToSend: async () => {
      calls.push("claim");
      return [row];
    },
    markPendingReplySent: async (id) => calls.push(["sent", id]),
    markPendingReplyError: async () => calls.push("unexpected-error")
  };

  const result = await processQueuedRepliesWithDeps(console, {
    database: fakeDb,
    postReply: async (accountId, locationId, reviewId, comment) => {
      calls.push(["post", accountId, locationId, reviewId, comment]);
    },
    markReplied: async (accountId, locationId, reviewId) => {
      calls.push(["replied", accountId, locationId, reviewId]);
    }
  });

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(calls, [
    "claim",
    ["post", "acct-1", "loc-1", "review-1", "Thanks for your feedback."],
    ["sent", 42],
    ["replied", "acct-1", "loc-1", "review-1"]
  ]);
});

test("processQueuedReplies releases claimed rows on post failure", async () => {
  const errors = [];
  const fakeDb = {
    useDb: () => true,
    claimPendingRepliesDueToSend: async () => [queuedRow({ id: 77 })],
    markPendingReplySent: async () => {
      throw new Error("should not mark sent");
    },
    markPendingReplyError: async (id, message) => errors.push({ id, message })
  };

  const result = await processQueuedRepliesWithDeps({ error() {} }, {
    database: fakeDb,
    postReply: async () => {
      throw new Error("google unavailable");
    },
    markReplied: async () => {
      throw new Error("should not mark replied");
    }
  });

  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(errors, [{ id: 77, message: "google unavailable" }]);
});
