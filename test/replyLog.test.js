import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;
const { reviewFields, replyLogToCsv, logReply, listReplyLog, currentReplyModel } = await import("../src/replyLog.js");

test("reviewFields maps Google star enums and reviewer/comment", () => {
  assert.deepEqual(
    reviewFields({ starRating: "FOUR", reviewer: { displayName: "Ann" }, comment: "Great" }),
    { rating: 4, reviewerName: "Ann", reviewComment: "Great" }
  );
  assert.deepEqual(reviewFields({ starRating: 2 }), { rating: 2, reviewerName: null, reviewComment: null });
  assert.deepEqual(reviewFields(null), { rating: null, reviewerName: null, reviewComment: null });
});

test("replyLogToCsv: header, quoting, embedded quotes/newlines", () => {
  const csv = replyLogToCsv([
    { postedAt: "2026-11-04T10:00:00.000Z", businessName: "Castle Nail Bar", rating: 5, replyText: 'Thanks, "Ann"!\nSee you', source: "auto" }
  ]);
  const [header, row] = csv.split("\r\n");
  assert.equal(header, "posted_at,business,account_id,location_id,review_id,rating,reviewer,review,reply,source,model");
  assert.ok(csv.includes('"Thanks, ""Ann""!\nSee you"'));
  assert.ok(row.startsWith("2026-11-04T10:00:00.000Z,Castle Nail Bar,"));
  assert.ok(csv.endsWith("\r\n"));
});

test("replyLogToCsv neutralizes spreadsheet formula injection in customer text", () => {
  const csv = replyLogToCsv([{ reviewComment: "=HYPERLINK(\"http://evil\")", reviewerName: "+1 bad", replyText: "-ok" }]);
  assert.ok(!/,=HYPERLINK/.test(csv));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(csv.includes(",'+1 bad,"));
  assert.ok(csv.includes(",'-ok,"));
});

test("logReply is a safe no-op without a database and never throws", async () => {
  assert.equal(await logReply({ accountId: "a", locationId: "l", reviewId: "r", replyText: "hi", source: "auto" }), false);
  assert.equal(await logReply(null), false);
});

test("listReplyLog returns empty without a database", async () => {
  assert.deepEqual(await listReplyLog({}), { rows: [], total: 0 });
});

test("currentReplyModel honors ANTHROPIC_MODEL", () => {
  const prev = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = "claude-opus-5-5";
  assert.equal(currentReplyModel(), "claude-opus-5-5");
  if (prev === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = prev;
});
