/**
 * Reply log — an append-only record of every reply Replyr posts to Google.
 *
 * source: "auto" (instant auto-reply), "delayed" (preview-mode reply posted
 * after the cancel window), "free" (trial free reply), "manual" (owner-written
 * reply sent through the API). AI-written rows are everything except "manual".
 *
 * Logging is best-effort: a failure to write the log never fails the reply
 * itself (the reply is already live on Google by the time we log it).
 */

import * as db from "./db.js";

export const REPLY_SOURCES = ["auto", "delayed", "free", "manual"];

/** Model the AI replies use (mirrors src/ai.js). Null for manual replies. */
export function currentReplyModel() {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
}

/** Map a Google review object to the log fields we keep. Pure. */
export function reviewFields(review) {
  const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  if (!review) return { rating: null, reviewerName: null, reviewComment: null };
  const rating =
    typeof review.starRating === "number" ? review.starRating : STAR[review.starRating] ?? null;
  return {
    rating,
    reviewerName: review.reviewer?.displayName || null,
    reviewComment: review.comment ? String(review.comment) : null
  };
}

/**
 * Record a posted reply. Never throws.
 * @param {{accountId:string, locationId:string, reviewId:string, replyText:string, source:string, rating?:number|null, reviewerName?:string|null, reviewComment?:string|null, model?:string|null}} entry
 * @param {{ logger?: object }} [opts]
 */
export async function logReply(entry, { logger = console } = {}) {
  try {
    if (!db.useDb()) return false;
    if (!entry?.accountId || !entry?.reviewId || !entry?.replyText) return false;
    const source = REPLY_SOURCES.includes(entry.source) ? entry.source : "auto";
    const model = source === "manual" ? null : entry.model ?? currentReplyModel();
    await db.query(
      `INSERT INTO reply_log (account_id, location_id, review_id, rating, reviewer_name, review_comment, reply_text, source, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.accountId,
        entry.locationId || "",
        entry.reviewId,
        entry.rating ?? null,
        entry.reviewerName ?? null,
        entry.reviewComment ?? null,
        entry.replyText,
        source,
        model
      ]
    );
    return true;
  } catch (err) {
    logger.warn?.({ err, accountId: entry?.accountId, reviewId: entry?.reviewId }, "reply_log write failed");
    return false;
  }
}

function rowToEntry(r) {
  return {
    id: r.id,
    accountId: r.account_id,
    locationId: r.location_id,
    businessName: r.business_name ?? null,
    reviewId: r.review_id,
    rating: r.rating,
    reviewerName: r.reviewer_name,
    reviewComment: r.review_comment,
    replyText: r.reply_text,
    source: r.source,
    model: r.model,
    postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null
  };
}

/**
 * List log rows newest-first, joined to the business name.
 * @param {{ accountId?: string|null, source?: string|null, aiOnly?: boolean, limit?: number, offset?: number }} [opts]
 */
export async function listReplyLog({ accountId = null, source = null, aiOnly = false, limit = 100, offset = 0 } = {}) {
  if (!db.useDb()) return { rows: [], total: 0 };
  const where = [];
  const params = [];
  if (accountId) {
    params.push(accountId);
    where.push(`l.account_id = $${params.length}`);
  }
  if (source && REPLY_SOURCES.includes(source)) {
    params.push(source);
    where.push(`l.source = $${params.length}`);
  } else if (aiOnly) {
    where.push(`l.source <> 'manual'`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const lim = Math.max(1, Math.min(5000, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  const totalRes = await db.query(`SELECT COUNT(*)::int AS n FROM reply_log l ${whereSql}`, params);
  const res = await db.query(
    `SELECT l.*, b.name AS business_name
       FROM reply_log l
       LEFT JOIN businesses b ON b.account_id = l.account_id AND b.location_id = l.location_id
       ${whereSql}
      ORDER BY l.posted_at DESC, l.id DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
  return { rows: res.rows.map(rowToEntry), total: totalRes.rows[0]?.n ?? 0 };
}

/** RFC 4180 CSV for a list of entries. Pure. Neutralizes spreadsheet formula injection. */
export function replyLogToCsv(entries) {
  const cols = [
    ["postedAt", "posted_at"],
    ["businessName", "business"],
    ["accountId", "account_id"],
    ["locationId", "location_id"],
    ["reviewId", "review_id"],
    ["rating", "rating"],
    ["reviewerName", "reviewer"],
    ["reviewComment", "review"],
    ["replyText", "reply"],
    ["source", "source"],
    ["model", "model"]
  ];
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    // A leading = + - @ (or tab/CR) makes Excel/Sheets evaluate the cell; review
    // text is customer-controlled, so prefix with a quote to keep it as text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(([, h]) => h).join(",")];
  for (const e of entries || []) lines.push(cols.map(([k]) => cell(e[k])).join(","));
  return lines.join("\r\n") + "\r\n";
}
