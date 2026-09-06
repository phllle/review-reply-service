import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FREE_REPLY_CAP,
  freeReplyEligibility,
  selectUnrepliedNewestFirst,
  freeRepliesToPost,
  reviewIdOf
} from "../src/freeReply.js";

const future = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

test("cap is 5", () => assert.equal(FREE_REPLY_CAP, 5));

test("eligibility: active trial, not subscribed, under cap -> ok with remaining", () => {
  const r = freeReplyEligibility({ trialEndsAt: future, subscribedAt: null, freeRepliesUsed: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.used, 2);
  assert.equal(r.remaining, 3);
});

test("eligibility: no active trial -> rejected (trial-only)", () => {
  const r = freeReplyEligibility({ trialEndsAt: past, freeRepliesUsed: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /free trial/i);
});

test("eligibility: missing trialEndsAt -> rejected", () => {
  const r = freeReplyEligibility({ trialEndsAt: null, freeRepliesUsed: 0 });
  assert.equal(r.ok, false);
});

test("eligibility: subscribed -> rejected even if trial active", () => {
  const r = freeReplyEligibility({ trialEndsAt: future, subscribedAt: past, freeRepliesUsed: 0 });
  assert.equal(r.ok, false);
});

test("eligibility: at cap -> specific 5-used error", () => {
  const r = freeReplyEligibility({ trialEndsAt: future, freeRepliesUsed: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "You've used your 5 free replies.");
});

test("reviewIdOf handles reviewId and name path", () => {
  assert.equal(reviewIdOf({ reviewId: "abc" }), "abc");
  assert.equal(reviewIdOf({ name: "accounts/1/locations/2/reviews/xyz" }), "xyz");
  assert.equal(reviewIdOf(null), "");
});

test("selectUnrepliedNewestFirst filters replied + already-owner-replied, sorts newest first", () => {
  const reviews = [
    { reviewId: "old", createTime: "2026-01-01T00:00:00Z" },
    { reviewId: "hasReply", createTime: "2026-03-01T00:00:00Z", reviewReply: { comment: "thanks" } },
    { reviewId: "new", createTime: "2026-05-01T00:00:00Z" },
    { reviewId: "mid", createTime: "2026-02-01T00:00:00Z" },
    { reviewId: "alreadyDone", createTime: "2026-06-01T00:00:00Z" }
  ];
  const out = selectUnrepliedNewestFirst(reviews, ["alreadyDone"]);
  assert.deepEqual(out.map((r) => r.reviewId), ["new", "mid", "old"]);
});

test("freeRepliesToPost = min(remaining, unreplied), and zero when none", () => {
  assert.equal(freeRepliesToPost(5, 12), 5);
  assert.equal(freeRepliesToPost(3, 12), 3);
  assert.equal(freeRepliesToPost(5, 2), 2);
  assert.equal(freeRepliesToPost(5, 0), 0);
  assert.equal(freeRepliesToPost(0, 4), 0);
});
