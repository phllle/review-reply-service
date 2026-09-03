import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeDigestStats,
  buildDigestEmail,
  createDigestUnsubToken,
  verifyDigestUnsubToken,
  isWeeklyDigestSlot
} from "../src/weeklyDigest.js";

const NOW = Date.parse("2026-06-15T12:00:00Z"); // Monday
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

test("computeDigestStats: counts this-week reviews and overall average", () => {
  const reviews = [
    { starRating: "FIVE", createTime: daysAgo(1) },
    { starRating: "FOUR", createTime: daysAgo(3) },
    { starRating: "TWO", createTime: daysAgo(2) },
    { starRating: "FIVE", createTime: daysAgo(30) } // outside window
  ];
  const s = computeDigestStats(reviews, { now: NOW, prevAvg: null });
  assert.equal(s.reviewsThisWeek, 3);
  assert.equal(s.lowStarThisWeek, 1); // the TWO
  assert.equal(s.totalReviews, 4);
  assert.equal(Number(s.overallAvg.toFixed(2)), 4.0); // (5+4+2+5)/4
});

test("computeDigestStats: counts replies posted this week by reply timestamp", () => {
  const reviews = [
    { starRating: "FIVE", createTime: daysAgo(40), reviewReply: { comment: "thanks", updateTime: daysAgo(2) } },
    { starRating: "ONE", createTime: daysAgo(3), reviewReply: { comment: "sorry", updateTime: daysAgo(30) } },
    { starRating: "FOUR", createTime: daysAgo(1) }
  ];
  const s = computeDigestStats(reviews, { now: NOW });
  assert.equal(s.repliesThisWeek, 1); // only the reply updated 2 days ago
});

test("computeDigestStats: ratingDelta uses previous snapshot", () => {
  const reviews = [{ starRating: "FIVE", createTime: daysAgo(1) }, { starRating: "FIVE", createTime: daysAgo(2) }];
  const s = computeDigestStats(reviews, { now: NOW, prevAvg: 4.0 });
  assert.equal(s.overallAvg, 5);
  assert.equal(s.ratingDelta, 1);
});

test("computeDigestStats: empty reviews produce null averages, no crash", () => {
  const s = computeDigestStats([], { now: NOW });
  assert.equal(s.reviewsThisWeek, 0);
  assert.equal(s.overallAvg, null);
  assert.equal(s.ratingDelta, null);
});

test("buildDigestEmail: subject + body reflect stats and themes", () => {
  const stats = computeDigestStats(
    [
      { starRating: "FIVE", createTime: daysAgo(1), reviewReply: { comment: "ty", updateTime: daysAgo(1) } },
      { starRating: "TWO", createTime: daysAgo(2), reviewReply: { comment: "sorry", updateTime: daysAgo(2) } }
    ],
    { now: NOW, prevAvg: 3.0 }
  );
  const { subject, text, html } = buildDigestEmail({
    businessName: "Castle Nail Bar",
    stats,
    themes: ["2 reviews mentioned wait times"],
    manageUrl: "https://replyr.pro/connected?accountId=x",
    unsubUrl: "https://replyr.pro/digest/unsubscribe?token=y"
  });
  assert.match(subject, /2 reviews handled/);
  assert.match(text, /Castle Nail Bar/);
  assert.match(text, /mentioned wait times/);
  assert.match(text, /Turn these off/);
  assert.match(html, /Manage your account/);
});

test("digest unsub token round-trips and rejects tampering", () => {
  const token = createDigestUnsubToken("acct-123");
  assert.equal(verifyDigestUnsubToken(token), "acct-123");
  assert.equal(verifyDigestUnsubToken("garbage"), null);
  assert.equal(verifyDigestUnsubToken(token + "x"), null);
});

test("isWeeklyDigestSlot: Monday 8am PT is a slot, other times are not", () => {
  // 2026-06-15 15:00 UTC = 08:00 PDT (Monday)
  assert.equal(isWeeklyDigestSlot(new Date("2026-06-15T15:00:00Z")), true);
  // 2026-06-15 18:00 UTC = 11:00 PDT (Monday, wrong hour)
  assert.equal(isWeeklyDigestSlot(new Date("2026-06-15T18:00:00Z")), false);
  // 2026-06-16 15:00 UTC = Tuesday
  assert.equal(isWeeklyDigestSlot(new Date("2026-06-16T15:00:00Z")), false);
});
