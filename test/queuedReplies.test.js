import { test } from "node:test";
import assert from "node:assert/strict";
import { processQueuedReplies } from "../src/auto.js";

test("processQueuedReplies claims due rows before posting and releases failed claims", async () => {
  const calls = [];
  let claimed = false;
  const rows = [
    {
      id: 1,
      accountId: "acct-1",
      locationId: "loc-1",
      reviewId: "rev-ok",
      generatedReply: "Thanks!"
    },
    {
      id: 2,
      accountId: "acct-1",
      locationId: "loc-1",
      reviewId: "rev-fail",
      generatedReply: "Please contact us."
    }
  ];
  const dbApi = {
    useDb() {
      return true;
    },
    async claimPendingRepliesDueToSend() {
      calls.push("claim");
      claimed = true;
      return rows;
    },
    async markPendingReplySent(id) {
      calls.push(`sent:${id}`);
      return true;
    },
    async markPendingReplyError(id, message) {
      calls.push(`error:${id}:${message}`);
    }
  };
  const added = [];

  const result = await processQueuedReplies(
    { error() {} },
    {
      dbApi,
      async replyToReviewFn(accountId, locationId, reviewId, comment) {
        assert.equal(claimed, true, "reply must only post after rows are claimed");
        calls.push(`post:${reviewId}:${comment}`);
        if (reviewId === "rev-fail") throw new Error("google outage");
      },
      async addRepliedReviewIdFn(accountId, locationId, reviewId) {
        added.push({ accountId, locationId, reviewId });
      }
    }
  );

  assert.deepEqual(result, { processed: 1, failed: 1 });
  assert.deepEqual(calls, [
    "claim",
    "post:rev-ok:Thanks!",
    "sent:1",
    "post:rev-fail:Please contact us.",
    "error:2:google outage"
  ]);
  assert.deepEqual(added, [{ accountId: "acct-1", locationId: "loc-1", reviewId: "rev-ok" }]);
});
