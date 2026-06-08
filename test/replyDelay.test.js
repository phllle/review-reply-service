import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMode,
  shouldDelayReply,
  getDelayMaxStar,
  getDelayMinutes,
  createCancelToken,
  verifyCancelToken,
  DEFAULT_MODE,
  DEFAULT_DELAY_MAX_STAR,
  DEFAULT_DELAY_MINUTES
} from "../src/replyDelay.js";
import { processQueuedReplies } from "../src/auto.js";

const SECRET = "test-cancel-secret-aaaaa";

test("normalizeMode: 'instant' / 'delayed' / unknown -> default", () => {
  assert.equal(normalizeMode("instant"), "instant");
  assert.equal(normalizeMode("DELAYED"), "delayed");
  assert.equal(normalizeMode(" Delayed "), "delayed");
  assert.equal(normalizeMode("queue"), DEFAULT_MODE);
  assert.equal(normalizeMode(null), DEFAULT_MODE);
  assert.equal(normalizeMode(undefined), DEFAULT_MODE);
  assert.equal(normalizeMode(""), DEFAULT_MODE);
});

test("getDelayMaxStar: returns env override only when 1..5", () => {
  assert.equal(getDelayMaxStar({ AUTO_REPLY_DELAY_MAX_STAR: "5" }), 5);
  assert.equal(getDelayMaxStar({ AUTO_REPLY_DELAY_MAX_STAR: "1" }), 1);
  assert.equal(getDelayMaxStar({ AUTO_REPLY_DELAY_MAX_STAR: "0" }), DEFAULT_DELAY_MAX_STAR);
  assert.equal(getDelayMaxStar({ AUTO_REPLY_DELAY_MAX_STAR: "-2" }), DEFAULT_DELAY_MAX_STAR);
  assert.equal(getDelayMaxStar({ AUTO_REPLY_DELAY_MAX_STAR: "abc" }), DEFAULT_DELAY_MAX_STAR);
  assert.equal(getDelayMaxStar({}), DEFAULT_DELAY_MAX_STAR);
});

test("getDelayMinutes: any positive integer >= 1, otherwise default", () => {
  assert.equal(getDelayMinutes({ AUTO_REPLY_DELAY_MINUTES: "30" }), 30);
  assert.equal(getDelayMinutes({ AUTO_REPLY_DELAY_MINUTES: "0" }), DEFAULT_DELAY_MINUTES);
  assert.equal(getDelayMinutes({ AUTO_REPLY_DELAY_MINUTES: "-5" }), DEFAULT_DELAY_MINUTES);
  assert.equal(getDelayMinutes({}), DEFAULT_DELAY_MINUTES);
});

test("shouldDelayReply: instant mode always posts immediately", () => {
  for (const rating of [1, 2, 3, 4, 5]) {
    assert.equal(
      shouldDelayReply({
        mode: "instant",
        rating,
        businessHasEmail: true,
        resendConfigured: true
      }),
      "instant"
    );
  }
});

test("shouldDelayReply: delayed mode delays low-star, instant for high-star", () => {
  const base = { mode: "delayed", businessHasEmail: true, resendConfigured: true };
  assert.equal(shouldDelayReply({ ...base, rating: 1 }), "delayed");
  assert.equal(shouldDelayReply({ ...base, rating: 2 }), "delayed");
  assert.equal(shouldDelayReply({ ...base, rating: 3 }), "delayed");
  assert.equal(shouldDelayReply({ ...base, rating: 4 }), "instant");
  assert.equal(shouldDelayReply({ ...base, rating: 5 }), "instant");
});

test("shouldDelayReply: env override of max-star", () => {
  const base = { mode: "delayed", businessHasEmail: true, resendConfigured: true };
  // Override to 1 — only 1-stars get delayed.
  assert.equal(shouldDelayReply({ ...base, rating: 2, env: { AUTO_REPLY_DELAY_MAX_STAR: "1" } }), "instant");
  assert.equal(shouldDelayReply({ ...base, rating: 1, env: { AUTO_REPLY_DELAY_MAX_STAR: "1" } }), "delayed");
});

test("shouldDelayReply: falls back to instant when business has no email", () => {
  assert.equal(
    shouldDelayReply({
      mode: "delayed",
      rating: 1,
      businessHasEmail: false,
      resendConfigured: true
    }),
    "instant"
  );
});

test("shouldDelayReply: falls back to instant when Resend isn't configured", () => {
  assert.equal(
    shouldDelayReply({
      mode: "delayed",
      rating: 1,
      businessHasEmail: true,
      resendConfigured: false
    }),
    "instant"
  );
});

test("shouldDelayReply: unknown rating posts instantly (don't queue ambiguous)", () => {
  assert.equal(
    shouldDelayReply({
      mode: "delayed",
      rating: null,
      businessHasEmail: true,
      resendConfigured: true
    }),
    "instant"
  );
});

test("createCancelToken / verifyCancelToken roundtrip", () => {
  const tok = createCancelToken("acct-1", "loc-1", "rev-abc", SECRET);
  assert.deepEqual(verifyCancelToken(tok, SECRET), {
    accountId: "acct-1",
    locationId: "loc-1",
    reviewId: "rev-abc"
  });
});

test("verifyCancelToken: rejects wrong secret", () => {
  const tok = createCancelToken("acct-1", "loc-1", "rev-abc", SECRET);
  assert.equal(verifyCancelToken(tok, "different-secret"), null);
});

test("verifyCancelToken: rejects garbage / missing parts / tampering", () => {
  assert.equal(verifyCancelToken("", SECRET), null);
  assert.equal(verifyCancelToken("not-base64url", SECRET), null);
  assert.equal(verifyCancelToken(undefined, SECRET), null);
  // Tamper: build a token for a different review with the original sig.
  const tok = createCancelToken("acct-1", "loc-1", "rev-abc", SECRET);
  const decoded = Buffer.from(tok, "base64url").toString("utf8");
  const parts = decoded.split("|");
  const tampered = ["cancel", parts[1], parts[2], "OTHER-REVIEW", parts[4]].join("|");
  const tamperedToken = Buffer.from(tampered, "utf8").toString("base64url");
  assert.equal(verifyCancelToken(tamperedToken, SECRET), null);
});

test("createCancelToken: throws when secret is missing", () => {
  assert.throws(() => createCancelToken("a", "b", "c", ""));
  assert.throws(() => createCancelToken("a", "b", "c", undefined));
});

test("verifyCancelToken: returns null when secret is missing", () => {
  const tok = createCancelToken("acct-1", "loc-1", "rev-abc", SECRET);
  assert.equal(verifyCancelToken(tok, ""), null);
});

test("processQueuedReplies: skips posting when atomic claim loses to cancellation", async () => {
  let posted = false;
  let markedSent = false;
  const result = await processQueuedReplies(
    { error: () => assert.fail("logger.error should not be called") },
    {
      db: {
        useDb: () => true,
        getPendingRepliesDueToSend: async () => [
          {
            id: 123,
            accountId: "acct-1",
            locationId: "loc-1",
            reviewId: "rev-1",
            generatedReply: "Thanks"
          }
        ],
        claimPendingReplyDueToSend: async () => null,
        markPendingReplySent: async () => {
          markedSent = true;
        }
      },
      replyToReview: async () => {
        posted = true;
      },
      addRepliedReviewId: async () => assert.fail("review state should not be updated"),
      sentry: { captureException: () => assert.fail("sentry should not be called") }
    }
  );

  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.equal(posted, false);
  assert.equal(markedSent, false);
});

test("processQueuedReplies: posts only the row returned by the atomic claim", async () => {
  const calls = [];
  const result = await processQueuedReplies(
    { error: () => assert.fail("logger.error should not be called") },
    {
      db: {
        useDb: () => true,
        getPendingRepliesDueToSend: async () => [
          {
            id: 123,
            accountId: "acct-selected",
            locationId: "loc-selected",
            reviewId: "rev-selected",
            generatedReply: "stale"
          }
        ],
        claimPendingReplyDueToSend: async (id) => ({
          id,
          accountId: "acct-claimed",
          locationId: "loc-claimed",
          reviewId: "rev-claimed",
          generatedReply: "claimed reply"
        }),
        markPendingReplySent: async (id) => calls.push(["sent", id]),
        markPendingReplyError: async () => assert.fail("markPendingReplyError should not be called")
      },
      replyToReview: async (...args) => calls.push(["post", ...args]),
      addRepliedReviewId: async (...args) => calls.push(["handled", ...args]),
      sentry: { captureException: () => assert.fail("sentry should not be called") }
    }
  );

  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.deepEqual(calls, [
    ["post", "acct-claimed", "loc-claimed", "rev-claimed", "claimed reply"],
    ["sent", 123],
    ["handled", "acct-claimed", "loc-claimed", "rev-claimed"]
  ]);
});
