import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverageRow, buildCoverage, sortCoverageRows, coverageStatus, coverageErrorLabel } from "../src/coverage.js";

const NOW = new Date("2026-11-11T18:00:00Z");

function business(overrides = {}) {
  return {
    accountId: "acct-1",
    locationId: "loc-1",
    name: "Castle Nail Bar",
    autoReplyEnabled: true,
    autoReplyMode: "instant",
    trialEndsAt: null,
    subscribedAt: null,
    isPro: false,
    freeRepliesUsed: 0,
    ...overrides
  };
}

function review(overrides = {}) {
  return {
    reviewer: { displayName: "Maria K." },
    starRating: "FIVE",
    comment: "Great service, will be back.",
    createTime: "2026-11-10T15:04:00Z",
    ...overrides
  };
}

test("buildCoverageRow: replied vs unreplied vs holding counts", () => {
  const row = buildCoverageRow({
    business: business(),
    reviews: [
      review({ reviewReply: { comment: "Thank you, Maria!" } }),
      review({ reviewReply: { comment: "" } }), // empty reply text = not answered
      review({}) // no reviewReply at all = not answered
    ],
    pendingCount: 2,
    reviewRequestStats: { total: 9, thisMonth: 4 },
    smsThisMonth: 37,
    now: NOW
  });
  assert.equal(row.reviewsTotal, 3);
  assert.equal(row.reviewsReplied, 1);
  assert.equal(row.reviewsHolding, 2);
  assert.equal(row.unreplied.length, 2);
  assert.equal(row.reviewRequestsTotal, 9);
  assert.equal(row.reviewRequestsThisMonth, 4);
  assert.equal(row.smsThisMonth, 37);
  assert.equal(row.error, null);
  assert.equal(row.name, "Castle Nail Bar");
  assert.equal(row.autoReplyEnabled, true);
  assert.equal(row.autoReplyMode, "instant");
});

test("buildCoverageRow: unreplied entries carry reviewer, numeric rating, time, snippet", () => {
  const longComment = "x".repeat(300);
  const row = buildCoverageRow({
    business: business(),
    reviews: [
      review({ reviewer: { displayName: "Jo" }, starRating: "TWO", comment: longComment, createTime: null, updateTime: "2026-11-09T10:00:00Z" }),
      review({ reviewer: {}, starRating: "UNKNOWN", comment: "" })
    ],
    now: NOW
  });
  const [first, second] = row.unreplied;
  assert.equal(first.reviewerName, "Jo");
  assert.equal(first.rating, 2);
  assert.equal(first.createTime, "2026-11-09T10:00:00Z"); // falls back to updateTime
  assert.equal(first.commentSnippet.length, 140);
  assert.ok(first.commentSnippet.endsWith("…"));
  assert.equal(second.reviewerName, "Customer"); // fallback when Google gives no name
  assert.equal(second.rating, 0);
  assert.equal(second.commentSnippet, "");
});

test("buildCoverageRow: error row keeps the failure on the row, counts zeroed", () => {
  const row = buildCoverageRow({
    business: business(),
    reviews: [],
    error: "Google token expired",
    now: NOW
  });
  assert.equal(row.error, "Google token expired");
  assert.equal(row.reviewsTotal, 0);
  assert.equal(row.reviewsReplied, 0);
  assert.deepEqual(row.unreplied, []);
  assert.equal(row.reviewRequestsTotal, 0); // stats default when not provided
  assert.equal(row.smsThisMonth, 0);
});

test("coverageStatus: pro / subscribed / trial / free / none", () => {
  assert.equal(coverageStatus(business({ isPro: true, proTier: "growth" }), NOW), "pro");
  assert.equal(coverageStatus(business({ subscribedAt: "2026-10-01T00:00:00Z" }), NOW), "subscribed");
  assert.equal(coverageStatus(business({ trialEndsAt: "2026-12-01T00:00:00Z" }), NOW), "trial");
  assert.equal(coverageStatus(business({ trialEndsAt: "2026-10-01T00:00:00Z" }), NOW), "free");
  assert.equal(coverageStatus(business({ signupAt: "2026-09-01T00:00:00Z" }), NOW), "free");
  assert.equal(coverageStatus(business({}), NOW), "none");
  const row = buildCoverageRow({ business: business({ trialEndsAt: "2026-12-01T00:00:00Z", freeRepliesUsed: 3 }), reviews: [], now: NOW });
  assert.equal(row.status, "trial");
  assert.equal(row.trialEndsAt, "2026-12-01T00:00:00Z");
  assert.equal(row.freeRepliesUsed, 3);
});

test("sortCoverageRows: unreplied first, then by name", () => {
  const rows = [
    { name: "Zebra Dental", unreplied: [] },
    { name: "Beta Salon", unreplied: [{ reviewerName: "A" }] },
    { name: "Alpha Nails", unreplied: [] },
    { name: "Aardvark Cafe", unreplied: [{ reviewerName: "B" }] }
  ];
  const sorted = sortCoverageRows(rows);
  assert.deepEqual(
    sorted.map((r) => r.name),
    ["Aardvark Cafe", "Beta Salon", "Alpha Nails", "Zebra Dental"]
  );
});

test("buildCoverage: a per-business Google failure lands in that row's error only", async () => {
  const good = business({ accountId: "good", locationId: "loc-g", name: "Good Biz" });
  const bad = business({ accountId: "bad", locationId: "loc-b", name: "Bad Biz" });
  const data = await buildCoverage({
    logger: { warn() {} },
    deps: {
      getAllBusinesses: async () => ({ "good::loc-g": good, "bad::loc-b": bad }),
      listReviews: async (accountId) => {
        if (accountId === "bad") throw new Error("invalid_grant");
        return [review({ reviewReply: { comment: "Thanks!" } }), review({})];
      },
      useDb: () => false
    }
  });
  assert.equal(data.rows.length, 2);
  const goodRow = data.rows.find((r) => r.accountId === "good");
  const badRow = data.rows.find((r) => r.accountId === "bad");
  assert.equal(goodRow.error, null);
  assert.equal(goodRow.reviewsTotal, 2);
  assert.equal(goodRow.reviewsReplied, 1);
  assert.equal(badRow.error, "invalid_grant");
  // Unreplied-first sort puts Good Biz (1 unreplied) ahead of Bad Biz (error, 0 unreplied).
  assert.equal(data.rows[0].accountId, "good");
});

test("buildCoverage: DB mode pulls pending count, request stats and SMS usage", async () => {
  const biz = business({ accountId: "pro-1", locationId: "loc-p", isPro: true });
  const data = await buildCoverage({
    logger: { warn() {} },
    deps: {
      getAllBusinesses: async () => ({ "pro-1::loc-p": biz }),
      listReviews: async () => [],
      useDb: () => true,
      listOpenPendingRepliesForAccount: async () => [{ reviewId: "r1" }, { reviewId: "r2" }, { reviewId: "r3" }],
      getReviewRequestStats: async (accountId, monthKey) => {
        assert.equal(accountId, "pro-1");
        assert.match(monthKey, /^\d{4}-\d{2}$/);
        return { total: 12, thisMonth: 5 };
      },
      getProSmsUsage: async () => 88
    }
  });
  const row = data.rows[0];
  assert.equal(row.reviewsHolding, 3);
  assert.equal(row.reviewRequestsTotal, 12);
  assert.equal(row.reviewRequestsThisMonth, 5);
  assert.equal(row.smsThisMonth, 88);
  assert.equal(row.status, "pro");
});

test("coverageErrorLabel: known Google failures become human-readable", () => {
  assert.equal(coverageErrorLabel(null), null);
  assert.equal(coverageErrorLabel(""), null);
  assert.match(coverageErrorLabel("invalid_grant"), /connection expired/);
  assert.match(
    coverageErrorLabel('Google API error 404: { "error": { "code": 404, "message": "Requested entity was not found.", "status": "NOT_FOUND" } }'),
    /couldn't find this location/
  );
  assert.match(
    coverageErrorLabel('Google API error 503: { "error": { "code": 503, "message": "The service is currently unavailable.", "status": "UNAVAILABLE" } }'),
    /temporarily unavailable/
  );
  assert.match(coverageErrorLabel("403 PERMISSION_DENIED"), /denied access/);
});

test("coverageErrorLabel: unknown errors pass through trimmed to one line", () => {
  assert.equal(coverageErrorLabel("weird\n  multi   line failure"), "weird multi line failure");
  const long = coverageErrorLabel("x".repeat(300));
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));
});
