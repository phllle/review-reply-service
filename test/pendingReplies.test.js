import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const db = await import("../src/db.js");

function pendingRow(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    account_id: overrides.account_id ?? "acct-1",
    location_id: overrides.location_id ?? "loc-1",
    review_id: overrides.review_id ?? "rev-1",
    rating: overrides.rating ?? 1,
    reviewer_name: overrides.reviewer_name ?? "Reviewer",
    review_comment: overrides.review_comment ?? "Bad experience",
    generated_reply: overrides.generated_reply ?? "Sorry about that.",
    send_after: overrides.send_after ?? new Date(Date.now() - 60_000),
    cancelled_at: overrides.cancelled_at ?? null,
    sent_at: overrides.sent_at ?? null,
    processing_at: overrides.processing_at ?? null,
    send_error: overrides.send_error ?? null,
    created_at: overrides.created_at ?? new Date()
  };
}

class PendingRepliesPool {
  constructor(rows) {
    this.rows = rows;
    this.queries = [];
  }

  async query(text, params = []) {
    this.queries.push({ text, params });
    if (text.includes("WITH due AS")) {
      assert.match(text, /FOR UPDATE SKIP LOCKED/);
      assert.match(text, /processing_at = NOW\(\)/);
      assert.match(text, /cancelled_at IS NULL/);
      assert.match(text, /sent_at IS NULL/);
      const [now, limit] = params;
      const due = this.rows
        .filter((row) => {
          const stale =
            row.processing_at &&
            new Date(row.processing_at).getTime() < Date.now() - 30 * 60 * 1000;
          return (
            !row.cancelled_at &&
            !row.sent_at &&
            (!row.processing_at || stale) &&
            new Date(row.send_after).getTime() <= new Date(now).getTime()
          );
        })
        .sort((a, b) => new Date(a.send_after) - new Date(b.send_after))
        .slice(0, limit);
      for (const row of due) {
        row.processing_at = new Date();
        row.send_error = null;
      }
      return { rows: due, rowCount: due.length };
    }

    if (text.includes("SET cancelled_at = NOW()")) {
      assert.match(text, /processing_at IS NULL/);
      assert.match(text, /INTERVAL '30 minutes'/);
      const [accountId, locationId, reviewId] = params;
      const row = this.rows.find(
        (candidate) =>
          candidate.account_id === accountId &&
          candidate.location_id === locationId &&
          candidate.review_id === reviewId &&
          !candidate.cancelled_at &&
          !candidate.sent_at &&
          (!candidate.processing_at ||
            new Date(candidate.processing_at).getTime() < Date.now() - 30 * 60 * 1000)
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.cancelled_at = new Date();
      row.processing_at = null;
      return { rows: [row], rowCount: 1 };
    }

    if (text.includes("SET sent_at = NOW()")) {
      assert.match(text, /processing_at = NULL/);
      assert.match(text, /cancelled_at IS NULL/);
      assert.match(text, /sent_at IS NULL/);
      const [id] = params;
      const row = this.rows.find((candidate) => candidate.id === id && !candidate.cancelled_at && !candidate.sent_at);
      if (!row) return { rows: [], rowCount: 0 };
      row.sent_at = new Date();
      row.processing_at = null;
      row.send_error = null;
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("SET send_error = $2")) {
      assert.match(text, /processing_at = NULL/);
      assert.match(text, /cancelled_at IS NULL/);
      assert.match(text, /sent_at IS NULL/);
      const [id, message] = params;
      const row = this.rows.find((candidate) => candidate.id === id && !candidate.cancelled_at && !candidate.sent_at);
      if (!row) return { rows: [], rowCount: 0 };
      row.send_error = message;
      row.processing_at = null;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

test("claimPendingRepliesDueToSend atomically claims only due, open replies", async () => {
  const rows = [
    pendingRow({ id: 1, review_id: "open" }),
    pendingRow({ id: 2, review_id: "cancelled", cancelled_at: new Date() }),
    pendingRow({ id: 3, review_id: "sent", sent_at: new Date() }),
    pendingRow({ id: 4, review_id: "processing", processing_at: new Date() }),
    pendingRow({ id: 5, review_id: "future", send_after: new Date(Date.now() + 60_000) })
  ];
  const pool = new PendingRepliesPool(rows);
  db.__setPoolForTest(pool);

  const claimed = await db.claimPendingRepliesDueToSend(new Date(), 200);

  assert.deepEqual(claimed.map((row) => row.reviewId), ["open"]);
  assert.ok(claimed[0].processingAt, "claimed row should expose processingAt");
  assert.equal(rows[0].send_error, null);
});

test("cancelPendingReply does not report success after a reply is claimed", async () => {
  const rows = [
    pendingRow({ id: 1, review_id: "claimed", processing_at: new Date() }),
    pendingRow({ id: 2, review_id: "open" }),
    pendingRow({ id: 3, review_id: "stale", processing_at: new Date(Date.now() - 31 * 60 * 1000) })
  ];
  const pool = new PendingRepliesPool(rows);
  db.__setPoolForTest(pool);

  assert.equal(await db.cancelPendingReply("acct-1", "loc-1", "claimed"), null);
  const cancelled = await db.cancelPendingReply("acct-1", "loc-1", "open");
  const staleCancelled = await db.cancelPendingReply("acct-1", "loc-1", "stale");

  assert.equal(cancelled.reviewId, "open");
  assert.ok(cancelled.cancelledAt, "open reply should be marked cancelled");
  assert.equal(staleCancelled.reviewId, "stale");
  assert.ok(staleCancelled.cancelledAt, "stale claim should be cancellable");
});

test("send success and failure both release the processing claim safely", async () => {
  const rows = [
    pendingRow({ id: 1, review_id: "success", processing_at: new Date(), send_error: "old" }),
    pendingRow({ id: 2, review_id: "failure", processing_at: new Date() }),
    pendingRow({ id: 3, review_id: "cancelled", cancelled_at: new Date(), processing_at: new Date() })
  ];
  const pool = new PendingRepliesPool(rows);
  db.__setPoolForTest(pool);

  assert.equal(await db.markPendingReplySent(1), true);
  await db.markPendingReplyError(2, "Google API unavailable");
  assert.equal(await db.markPendingReplySent(3), false);

  assert.ok(rows[0].sent_at, "sent reply should be terminal");
  assert.equal(rows[0].processing_at, null);
  assert.equal(rows[0].send_error, null);
  assert.equal(rows[1].sent_at, null);
  assert.equal(rows[1].processing_at, null);
  assert.equal(rows[1].send_error, "Google API unavailable");
  assert.ok(rows[2].cancelled_at, "cancelled reply should remain cancelled");
  assert.ok(rows[2].processing_at, "cancelled terminal row should not be modified by mark sent");
});
