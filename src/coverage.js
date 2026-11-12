/**
 * Per-business coverage view (admin).
 *
 * Answers the operator's question for every business using Replyr: "are all
 * your reviews being responded to — and are review requests going out?"
 *
 * buildCoverageRow is PURE: it takes a business row plus already-fetched
 * inputs (the business's Google reviews, its open pending-reply count, and
 * its review-request stats) and returns one flat coverage row. All IO lives
 * in buildCoverage (used by the /admin/coverage routes), so the aggregation
 * is unit-testable without Google or the DB.
 *
 * A review counts as answered iff Google shows an owner reply on it
 * (reviewReply.comment non-empty) — the same ground truth the auto-reply
 * engine itself uses in auto.js.
 */

import * as db from "./db.js";
import { getAllBusinesses } from "./businesses.js";
import { listReviews } from "./google.js";
import { classifyBusinessPlan } from "./metrics.js";
import { getCurrentMonthKey } from "./proPlan.js";

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const SNIPPET_MAX = 140;

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

function snippet(comment) {
  const text = oneLine(comment);
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

/**
 * Display status for a business: classifyBusinessPlan gives the billing plan
 * ("base" | "pro_*" | "none"); coverage shows the lifecycle label the
 * operator thinks in — subscribed / pro / trial / free / none.
 */
export function coverageStatus(business, now = new Date()) {
  const plan = classifyBusinessPlan(business);
  if (plan.startsWith("pro_")) return "pro";
  if (plan === "base") return "subscribed";
  const trialEndsAt = business?.trialEndsAt ? new Date(business.trialEndsAt) : null;
  if (trialEndsAt && !Number.isNaN(trialEndsAt.getTime()) && trialEndsAt > now) return "trial";
  if (trialEndsAt || business?.signupAt) return "free";
  return "none";
}

/**
 * Pure aggregation. Inputs:
 * - business: a businesses row (see businesses.js shape)
 * - reviews: array of Google reviews (listReviews output), or null on error
 * - pendingCount: open pending_replies for this location (preview holds)
 * - reviewRequestStats: { total, thisMonth } from db.getReviewRequestStats
 * - smsThisMonth: db.getProSmsUsage for the current month
 * - error: message from a failed fetch for this business, or null
 */
export function buildCoverageRow({
  business,
  reviews = [],
  pendingCount = 0,
  reviewRequestStats = null,
  smsThisMonth = 0,
  error = null,
  now = new Date()
} = {}) {
  const b = business || {};
  const list = Array.isArray(reviews) ? reviews : [];
  let reviewsReplied = 0;
  const unreplied = [];
  for (const r of list) {
    if (r?.reviewReply?.comment) {
      reviewsReplied += 1;
    } else {
      unreplied.push({
        reviewerName: oneLine(r?.reviewer?.displayName) || "Customer",
        rating: STAR[r?.starRating] || 0,
        createTime: r?.createTime || r?.updateTime || null,
        commentSnippet: snippet(r?.comment)
      });
    }
  }
  return {
    name: b.name || null,
    accountId: b.accountId || null,
    locationId: b.locationId || null,
    autoReplyEnabled: !!b.autoReplyEnabled,
    autoReplyMode: b.autoReplyMode || "instant",
    status: coverageStatus(b, now),
    trialEndsAt: b.trialEndsAt || null,
    freeRepliesUsed: Number(b.freeRepliesUsed) || 0,
    reviewsTotal: list.length,
    reviewsReplied,
    reviewsHolding: Math.max(0, Number(pendingCount) || 0),
    unreplied,
    reviewRequestsTotal: Number(reviewRequestStats?.total) || 0,
    reviewRequestsThisMonth: Number(reviewRequestStats?.thisMonth) || 0,
    smsThisMonth: Number(smsThisMonth) || 0,
    error: error ? String(error) : null
  };
}

/** Sort: businesses with unreplied reviews first, then by name. */
export function sortCoverageRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const aOpen = (a.unreplied?.length || 0) > 0 ? 0 : 1;
    const bOpen = (b.unreplied?.length || 0) > 0 ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return String(a.name || a.accountId || "").localeCompare(String(b.name || b.accountId || ""));
  });
}

/**
 * IO: build coverage rows for every business. A failure for one business
 * (expired Google token, Google outage) is captured in that row's `error`
 * field — it never fails the whole report.
 *
 * `deps` is injectable for tests.
 */
export async function buildCoverage({ logger = console, deps = {} } = {}) {
  const loadBusinesses = deps.getAllBusinesses || getAllBusinesses;
  const fetchReviews = deps.listReviews || listReviews;
  const fetchPending = deps.listOpenPendingRepliesForAccount || db.listOpenPendingRepliesForAccount;
  const fetchRequestStats = deps.getReviewRequestStats || db.getReviewRequestStats;
  const fetchSmsUsage = deps.getProSmsUsage || db.getProSmsUsage;
  const useDb = deps.useDb ? deps.useDb() : db.useDb();
  const monthKey = getCurrentMonthKey();
  const now = new Date();

  const businessesObj = await loadBusinesses();
  const businesses = Object.values(businessesObj || {});
  const rows = [];
  for (const business of businesses) {
    try {
      let reviews = [];
      let error = null;
      try {
        reviews = (await fetchReviews(business.accountId, business.locationId)) || [];
      } catch (err) {
        error = err?.message || String(err);
        logger?.warn?.({ err, accountId: business.accountId }, "Coverage: could not list reviews");
      }
      let pendingCount = 0;
      let reviewRequestStats = { total: 0, thisMonth: 0 };
      let smsThisMonth = 0;
      if (useDb) {
        try {
          const pending = await fetchPending(business.accountId, business.locationId);
          pendingCount = Array.isArray(pending) ? pending.length : 0;
        } catch (err) {
          logger?.warn?.({ err, accountId: business.accountId }, "Coverage: could not load pending replies");
        }
        try {
          reviewRequestStats = await fetchRequestStats(business.accountId, monthKey);
        } catch (err) {
          logger?.warn?.({ err, accountId: business.accountId }, "Coverage: could not load review-request stats");
        }
        try {
          smsThisMonth = await fetchSmsUsage(business.accountId, monthKey);
        } catch (err) {
          logger?.warn?.({ err, accountId: business.accountId }, "Coverage: could not load SMS usage");
        }
      }
      rows.push(buildCoverageRow({ business, reviews, pendingCount, reviewRequestStats, smsThisMonth, error, now }));
    } catch (err) {
      logger?.warn?.({ err, accountId: business?.accountId }, "Coverage: row failed");
      rows.push(
        buildCoverageRow({
          business,
          reviews: [],
          error: err?.message || String(err),
          now
        })
      );
    }
  }
  return { generatedAt: now.toISOString(), monthKey, rows: sortCoverageRows(rows) };
}
