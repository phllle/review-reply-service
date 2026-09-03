/**
 * Weekly summary digest to the business OWNER (transactional, not marketing).
 *
 * "We handled 14 reviews, your rating went 4.3 → 4.5, 3 people mentioned wait
 * times." This is proof-of-value + churn defense: set-and-forget customers who
 * never log in still see what Replyr did for them.
 *
 * Sent via Resend (plain owner email). Gated per-business so a persistent hourly
 * scheduler can't double-send within a week. Owners opt out via a dashboard
 * toggle or the one-click link in each email.
 */

import crypto from "crypto";
import { getEnabledBusinesses, upsertBusiness } from "./businesses.js";
import { listReviews } from "./google.js";
import { extractReviewThemesWithClaude } from "./ai.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL?.trim() || "Replyr <onboarding@resend.dev>";
const BASE_URL = ((process.env.BASE_URL || "").trim() || "http://localhost:3000").replace(/\/$/, "");
const DIGEST_SECRET =
  process.env.REPLYR_SESSION_SECRET?.trim() || process.env.UNSUBSCRIBE_SECRET?.trim() || "replyr-digest";

const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
function mapStar(starRating) {
  return STAR_MAP[starRating] ?? null;
}

/**
 * Pure stat computation over a location's full review list.
 * @param {Array} reviews - Google review objects
 * @param {object} opts - { now?: epoch ms, prevAvg?: number|null, windowDays?: number }
 * @returns {object} digest stats
 */
export function computeDigestStats(reviews, opts = {}) {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? 7;
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  const prevAvg = typeof opts.prevAvg === "number" && !Number.isNaN(opts.prevAvg) ? opts.prevAvg : null;

  let totalCount = 0;
  let totalSum = 0;
  let weekCount = 0;
  let weekSum = 0;
  let weekLowStar = 0;
  let repliesThisWeek = 0;

  for (const r of reviews || []) {
    const rating = mapStar(r?.starRating);
    if (rating == null) continue;
    totalCount += 1;
    totalSum += rating;

    const created = Date.parse(r.createTime || r.updateTime || "");
    if (!Number.isNaN(created) && created >= cutoff) {
      weekCount += 1;
      weekSum += rating;
      if (rating <= 3) weekLowStar += 1;
    }
    // Count replies posted this week (by reply timestamp), regardless of when
    // the underlying review was left.
    if (r.reviewReply && r.reviewReply.comment) {
      const repliedAt = Date.parse(r.reviewReply.updateTime || "");
      if (!Number.isNaN(repliedAt) && repliedAt >= cutoff) repliesThisWeek += 1;
    }
  }

  const overallAvg = totalCount ? totalSum / totalCount : null;
  const weekAvg = weekCount ? weekSum / weekCount : null;
  return {
    reviewsThisWeek: weekCount,
    repliesThisWeek,
    lowStarThisWeek: weekLowStar,
    weekAvg,
    overallAvg,
    prevAvg,
    ratingDelta: prevAvg != null && overallAvg != null ? overallAvg - prevAvg : null,
    totalReviews: totalCount
  };
}

/** One-click opt-out token, bound to accountId. */
export function createDigestUnsubToken(accountId) {
  const payload = `digest:${accountId}`;
  const sig = crypto.createHmac("sha256", DIGEST_SECRET).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

/** @returns {string|null} accountId if the token is valid, else null. */
export function verifyDigestUnsubToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const marker = decoded.indexOf(":");
    const lastColon = decoded.lastIndexOf(":");
    if (marker === -1 || lastColon === marker) return null;
    const payload = decoded.slice(0, lastColon);
    const sig = decoded.slice(lastColon + 1);
    if (!payload.startsWith("digest:")) return null;
    const expected = crypto.createHmac("sha256", DIGEST_SECRET).update(payload).digest("base64url");
    if (sig !== expected) return null;
    return payload.slice("digest:".length) || null;
  } catch {
    return null;
  }
}

function fmtAvg(v) {
  return v == null ? "—" : v.toFixed(1);
}

/**
 * Build the digest email (subject + plain text + HTML). Pure/testable.
 * @param {object} opts - { businessName, stats, themes:string[], manageUrl, unsubUrl }
 */
export function buildDigestEmail({ businessName = "your business", stats, themes = [], manageUrl, unsubUrl }) {
  const s = stats || {};
  const subject = `Your Replyr week: ${s.reviewsThisWeek || 0} review${s.reviewsThisWeek === 1 ? "" : "s"} handled`;

  let trendLine;
  if (s.ratingDelta != null && Math.abs(s.ratingDelta) >= 0.05) {
    const arrow = s.ratingDelta > 0 ? "↑" : "↓";
    trendLine = `Your rating ${arrow} ${fmtAvg(s.prevAvg)} → ${fmtAvg(s.overallAvg)}`;
  } else {
    trendLine = `Your rating is holding at ${fmtAvg(s.overallAvg)}`;
  }

  const lines = [
    `Here's what Replyr did for ${businessName} this week:`,
    ``,
    `• ${s.reviewsThisWeek || 0} new review${s.reviewsThisWeek === 1 ? "" : "s"}`,
    `• ${s.repliesThisWeek || 0} repl${s.repliesThisWeek === 1 ? "y" : "ies"} posted on your behalf`,
    `• ${trendLine} (across ${s.totalReviews || 0} total reviews)`
  ];
  if (s.lowStarThisWeek > 0) {
    lines.push(`• ${s.lowStarThisWeek} low-star (1–3★) review${s.lowStarThisWeek === 1 ? "" : "s"} — we responded professionally`);
  }
  if (themes.length) {
    lines.push(``, `What customers talked about:`);
    for (const t of themes) lines.push(`• ${t}`);
  }
  lines.push(``, `Manage your account: ${manageUrl}`, ``, `—`, `You're getting this weekly summary from Replyr.`, `Turn these off: ${unsubUrl}`);
  const text = lines.join("\n");

  const themeHtml = themes.length
    ? `<p style="margin:18px 0 6px;font-weight:600;color:#f0ede8;">What customers talked about</p><ul style="margin:0;padding-left:18px;color:#b8b6bf;line-height:1.7;">${themes
        .map((t) => `<li>${escapeHtml(t)}</li>`)
        .join("")}</ul>`
    : "";
  const lowStarHtml =
    s.lowStarThisWeek > 0
      ? `<li><strong>${s.lowStarThisWeek}</strong> low-star (1–3★) review${s.lowStarThisWeek === 1 ? "" : "s"} — we responded professionally</li>`
      : "";
  const html = `
<div style="max-width:520px;margin:0 auto;font-family:-apple-system,system-ui,sans-serif;background:#0f0f11;color:#f0ede8;padding:28px 24px;border-radius:16px;">
  <div style="font-size:15px;font-weight:700;letter-spacing:-0.01em;margin-bottom:18px;">💬 Replyr</div>
  <p style="margin:0 0 14px;font-size:15px;">Here's what Replyr did for <strong>${escapeHtml(businessName)}</strong> this week:</p>
  <ul style="margin:0;padding-left:18px;color:#b8b6bf;line-height:1.8;font-size:14px;">
    <li><strong>${s.reviewsThisWeek || 0}</strong> new review${s.reviewsThisWeek === 1 ? "" : "s"}</li>
    <li><strong>${s.repliesThisWeek || 0}</strong> repl${s.repliesThisWeek === 1 ? "y" : "ies"} posted on your behalf</li>
    <li>${escapeHtml(trendLine)} <span style="color:#7a7880;">(across ${s.totalReviews || 0} total)</span></li>
    ${lowStarHtml}
  </ul>
  ${themeHtml}
  <p style="margin:22px 0 0;"><a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#4a9eff;color:#0f0f11;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px;font-size:14px;">Manage your account</a></p>
  <p style="margin-top:22px;font-size:12px;color:#7a7880;">You're getting this weekly summary from Replyr. <a href="${escapeHtml(unsubUrl)}" style="color:#7a7880;">Turn these off</a>.</p>
</div>`;
  return { subject, text, html };
}

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => d[c]);
}

/** Send one digest email to the owner. Returns { ok } or throws. */
export async function sendDigestEmail({ to, subject, text, html }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set; cannot send digest");
  const email = (to || "").trim().toLowerCase();
  if (!email) throw new Error("Missing owner email");
  const { Resend } = await import("resend");
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({ from: FROM_EMAIL, to: [email], subject, text, html });
  if (error) throw new Error(error.message);
  return { ok: true };
}

/** True if it's the weekly send slot in Pacific Time (Monday, 8:00–8:59am PT). */
export function isWeeklyDigestSlot(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    hour12: false
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return weekday === "Mon" && hour === 8;
}

/**
 * Scheduler entry point. Iterate enabled businesses; if it's the weekly slot and
 * this business hasn't been sent in the last 6 days, compute + send its digest.
 */
export async function runWeeklyDigests(logger = console, now = new Date()) {
  if (!RESEND_API_KEY) return { sent: 0, skipped: 0, reason: "no-resend" };
  if (!isWeeklyDigestSlot(now)) return { sent: 0, skipped: 0, reason: "not-slot" };

  const nowMs = now.getTime();
  const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
  let businesses = [];
  try {
    businesses = await getEnabledBusinesses();
  } catch (err) {
    logger.error?.(err, "Weekly digest: failed to list businesses");
    return { sent: 0, skipped: 0, reason: "list-failed" };
  }

  let sent = 0;
  let skipped = 0;
  for (const biz of businesses) {
    try {
      if (biz.weeklyDigestEnabled === false) { skipped += 1; continue; }
      const ownerEmail = (biz.notificationEmail || "").trim();
      if (!ownerEmail) { skipped += 1; continue; }
      if (biz.lastWeeklyDigestAt && nowMs - Date.parse(biz.lastWeeklyDigestAt) < sixDaysMs) {
        skipped += 1;
        continue;
      }

      const reviews = await listReviews(biz.accountId, biz.locationId);
      const stats = computeDigestStats(reviews, { now: nowMs, prevAvg: biz.lastDigestRatingAvg });

      // Skip businesses with zero activity and no history — nothing to say.
      if (stats.reviewsThisWeek === 0 && stats.repliesThisWeek === 0 && biz.lastDigestRatingAvg == null) {
        // Still record the snapshot so next week has a baseline for trend.
        await upsertBusiness({
          accountId: biz.accountId,
          locationId: biz.locationId,
          lastDigestRatingAvg: stats.overallAvg,
          lastWeeklyDigestAt: new Date(nowMs).toISOString()
        });
        skipped += 1;
        continue;
      }

      const weekCutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
      const comments = (reviews || [])
        .filter((r) => {
          const t = Date.parse(r.createTime || r.updateTime || "");
          return !Number.isNaN(t) && t >= weekCutoff && r.comment;
        })
        .map((r) => r.comment);
      const themes = comments.length ? await extractReviewThemesWithClaude(comments) : [];

      const manageUrl = `${BASE_URL}/connected?accountId=${encodeURIComponent(biz.accountId)}`;
      const unsubUrl = `${BASE_URL}/digest/unsubscribe?token=${encodeURIComponent(createDigestUnsubToken(biz.accountId))}`;
      const { subject, text, html } = buildDigestEmail({
        businessName: biz.name || "your business",
        stats,
        themes,
        manageUrl,
        unsubUrl
      });
      await sendDigestEmail({ to: ownerEmail, subject, text, html });

      await upsertBusiness({
        accountId: biz.accountId,
        locationId: biz.locationId,
        lastDigestRatingAvg: stats.overallAvg,
        lastWeeklyDigestAt: new Date(nowMs).toISOString()
      });
      sent += 1;
      logger.info?.({ accountId: biz.accountId, reviewsThisWeek: stats.reviewsThisWeek }, "Weekly digest sent");
    } catch (err) {
      logger.error?.({ err, accountId: biz.accountId }, "Weekly digest failed for business");
    }
  }
  return { sent, skipped };
}
