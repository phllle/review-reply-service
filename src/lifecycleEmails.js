/**
 * Lifecycle emails — one-shot retention nudges, each sent exactly once per
 * account (guarded by a *_sent_at stamp on the business record, written only
 * after a successful send):
 *
 * - free_replies_nudge: a triallist who hasn't used all 5 free trial replies
 *   yet, nudged from day 2 of the trial to use them before the trial ends.
 * - trial_ending: an unsubscribed triallist whose trial ends within 3 days —
 *   after the end date, auto-replies stop and new reviews sit unanswered.
 * - winback: an account whose subscription was cancelled (recorded by the
 *   Stripe webhook in sub_cancelled_at / sub_access_ends_at) — re-enable
 *   before access ends, or come back after it does.
 *
 * Same shape as onboardingEmails.js: pure builders + selection (testable),
 * senders that never throw and report { sent, reason }, a runner that
 * self-gates to business hours in Pacific Time and is called from the hourly
 * campaign scheduler tick.
 *
 * Copy signs "— Replyr" (never a personal name). Cancellation state is
 * account-level: multi-location accounts pick/stamp via their primary row
 * and stamp every location row so siblings can't re-trigger a send.
 */

import { getAllBusinesses, getBusinessesForAccount, upsertBusiness } from "./businesses.js";
import { settingsUrlFor } from "./onboardingEmails.js";
import { FREE_REPLY_CAP } from "./freeReply.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_LENGTH_DAYS = 30;

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => d[c]);
}

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

function toMs(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Whole days from `now` until `dateLike`, rounding up; null when unparseable. */
export function daysUntil(dateLike, now = new Date()) {
  const t = toMs(dateLike);
  if (t == null) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / DAY_MS));
}

/** "Nov 20" — used in the winback subject line. UTC so the date matches the stored ISO. */
export function formatShortDate(dateLike) {
  const t = toMs(dateLike);
  if (t == null) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(t));
}

/** "Friday, November 14" — used in email bodies. */
export function formatLongDate(dateLike) {
  const t = toMs(dateLike);
  if (t == null) return "";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(t));
}

/**
 * When this account's trial started: the explicit signup timestamp when the
 * account has one, else derived as trialEndsAt − 30 days (same derivation as
 * computeFunnel in metrics.js). Null when neither is available.
 */
export function trialStartedAt(business) {
  if (!business) return null;
  const signup = toMs(business.signupAt);
  if (signup != null) return new Date(signup);
  const trialEnd = toMs(business.trialEndsAt);
  if (trialEnd != null) return new Date(trialEnd - TRIAL_LENGTH_DAYS * DAY_MS);
  return null;
}

// --- Selection (pure) ---------------------------------------------------------

/**
 * Pick which lifecycle emails are due. One pick max per account: businesses
 * are deduplicated by accountId (first row wins — the account's primary
 * location, matching getBusiness), and winback outranks the trial emails.
 *
 * @param {object[]} businesses — business rows (array or map values)
 * @param {Date} [now]
 * @returns {{ accountId: string, type: "free_replies_nudge"|"trial_ending"|"winback" }[]}
 */
export function selectLifecycleEmails(businesses, now = new Date()) {
  const list = Array.isArray(businesses) ? businesses : Object.values(businesses || {});
  const nowMs = now.getTime();
  const byAccount = new Map();
  for (const b of list) {
    if (!b || !b.accountId) continue;
    if (!byAccount.has(b.accountId)) byAccount.set(b.accountId, b);
  }
  const picks = [];
  for (const b of byAccount.values()) {
    // Winback: subscription cancelled and we haven't emailed about it yet.
    // (A resubscribe clears subCancelledAt + winbackSentAt in the webhook,
    // so a later second cancellation can email again.)
    if (b.subCancelledAt && !b.winbackSentAt) {
      picks.push({ accountId: b.accountId, type: "winback" });
      continue;
    }
    // Trial emails never go to paying or Pro accounts.
    if (b.subscribedAt || b.isPro) continue;
    const trialEnd = toMs(b.trialEndsAt);
    if (trialEnd == null) continue;
    // Trial ending: ends within (now, now + 3 days].
    if (trialEnd > nowMs && trialEnd <= nowMs + 3 * DAY_MS && !b.trialEndingSentAt) {
      picks.push({ accountId: b.accountId, type: "trial_ending" });
      continue;
    }
    // Free-replies nudge: trial still running, free replies left, and the
    // trial started at least 2 days ago (they've had a chance to use them).
    if (trialEnd > nowMs && !b.trialNudgeSentAt && (Number(b.freeRepliesUsed) || 0) < FREE_REPLY_CAP) {
      const started = trialStartedAt(b);
      if (started && nowMs - started.getTime() >= 2 * DAY_MS) {
        picks.push({ accountId: b.accountId, type: "free_replies_nudge" });
      }
    }
  }
  return picks;
}

// --- Stripe cancellation mapping (pure) ---------------------------------------

/**
 * The subscription's current period end as unix seconds. Newer Stripe API
 * versions moved it onto the first subscription item, so check the
 * subscription itself first, then items.data[0].
 */
export function subscriptionPeriodEndSeconds(subscription) {
  if (!subscription) return null;
  const direct = Number(subscription.current_period_end);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const itemEnd = Number(subscription.items?.data?.[0]?.current_period_end);
  if (Number.isFinite(itemEnd) && itemEnd > 0) return itemEnd;
  return null;
}

/**
 * Map a customer.subscription.updated event to a business patch:
 * - cancel_at_period_end → record when they cancelled (earliest wins) and
 *   when access ends.
 * - no longer cancelling while active → they re-enabled: clear the
 *   cancellation state AND the winback stamp, so a future cancellation can
 *   send a fresh winback email.
 * Returns null when the event changes nothing.
 */
export function cancellationPatchFromSubscription({ subscription, business, now = new Date() } = {}) {
  if (!subscription) return null;
  if (subscription.cancel_at_period_end) {
    const endSec = subscriptionPeriodEndSeconds(subscription);
    return {
      subCancelledAt: business?.subCancelledAt || now.toISOString(),
      subAccessEndsAt: endSec ? new Date(endSec * 1000).toISOString() : business?.subAccessEndsAt ?? null
    };
  }
  if (subscription.status === "active") {
    return { subCancelledAt: null, subAccessEndsAt: null, winbackSentAt: null };
  }
  return null;
}

// --- Builders -----------------------------------------------------------------

export const FREE_REPLIES_NUDGE_SUBJECT = "You still have free review replies waiting";

/** Pure: build the free-replies nudge email (subject + text + html). */
export function buildFreeRepliesNudgeEmail({ accountId, freeRepliesUsed = 0, settingsUrl } = {}) {
  const settings = settingsUrl || settingsUrlFor(accountId);
  const used = Math.min(FREE_REPLY_CAP, Math.max(0, Number(freeRepliesUsed) || 0));
  const remaining = FREE_REPLY_CAP - used;
  const text = [
    `Quick heads-up: you've used ${used} of your ${FREE_REPLY_CAP} free Replyr trial replies — ${remaining} ${remaining === 1 ? "is" : "are"} still waiting.`,
    "",
    "While your trial runs, every new Google review gets a reply written in your voice and posted as your business, automatically. No card needed during the trial — the free replies only get used when real reviews come in.",
    "",
    `Make sure auto-reply is on and your voice sounds right: ${settings}`,
    "",
    "— Replyr"
  ].join("\n");
  const html = [
    `<p>Quick heads-up: you've used ${used} of your ${FREE_REPLY_CAP} free Replyr trial replies — ${remaining} ${remaining === 1 ? "is" : "are"} still waiting.</p>`,
    `<p>While your trial runs, every new Google review gets a reply written in your voice and posted as your business, automatically. No card needed during the trial — the free replies only get used when real reviews come in.</p>`,
    `<p><a href="${escapeHtml(settings)}">Make sure auto-reply is on and your voice sounds right</a></p>`,
    `<p>— Replyr</p>`
  ].join("\n");
  return { subject: FREE_REPLIES_NUDGE_SUBJECT, text, html };
}

export function trialEndingSubject(daysLeft) {
  const n = Math.max(0, Number(daysLeft) || 0);
  return `Your Replyr trial ends in ${n} day${n === 1 ? "" : "s"}`;
}

/** Pure: build the trial-ending email (subject + text + html). */
export function buildTrialEndingEmail({ accountId, trialEndsAt, settingsUrl, now = new Date() } = {}) {
  const settings = settingsUrl || settingsUrlFor(accountId);
  const days = daysUntil(trialEndsAt, now) ?? 0;
  const endDate = formatLongDate(trialEndsAt);
  const text = [
    `Your free Replyr trial ends ${endDate ? `on ${endDate}` : "soon"} — that's ${days} day${days === 1 ? "" : "s"} away.`,
    "",
    "When it ends, automatic replies stop, and new Google reviews will sit unanswered until someone replies by hand.",
    "",
    `Keep every review answered for $19/month — subscribe in a minute from your settings: ${settings}`,
    "",
    "— Replyr"
  ].join("\n");
  const html = [
    `<p>Your free Replyr trial ends ${endDate ? `on ${escapeHtml(endDate)}` : "soon"} — that's ${days} day${days === 1 ? "" : "s"} away.</p>`,
    `<p>When it ends, automatic replies stop, and new Google reviews will sit unanswered until someone replies by hand.</p>`,
    `<p><a href="${escapeHtml(settings)}">Keep every review answered for $19/month</a> — subscribe in a minute from your settings.</p>`,
    `<p>— Replyr</p>`
  ].join("\n");
  return { subject: trialEndingSubject(days), text, html };
}

export const WINBACK_OFF_SUBJECT = "Your Replyr auto-reply is off";

/** Pure: build the winback email (subject + text + html). Two variants:
 * access still running (turn-off date known and in the future) vs already off. */
export function buildWinbackEmail({ accountId, accessEndsAt, settingsUrl, now = new Date() } = {}) {
  const settings = settingsUrl || settingsUrlFor(accountId);
  const endMs = toMs(accessEndsAt);
  const stillActive = endMs != null && endMs > now.getTime();
  if (stillActive) {
    const short = formatShortDate(accessEndsAt);
    const long = formatLongDate(accessEndsAt);
    const text = [
      `Your Replyr plan is set to end on ${long}. Until then, your review replies keep posting as usual.`,
      "",
      "Changed your mind? Re-enable in two clicks from your settings and nothing switches off — no need to reconnect Google or set anything up again:",
      "",
      settings,
      "",
      "— Replyr"
    ].join("\n");
    const html = [
      `<p>Your Replyr plan is set to end on ${escapeHtml(long)}. Until then, your review replies keep posting as usual.</p>`,
      `<p>Changed your mind? <a href="${escapeHtml(settings)}">Re-enable in two clicks</a> and nothing switches off — no need to reconnect Google or set anything up again.</p>`,
      `<p>— Replyr</p>`
    ].join("\n");
    return { subject: `Your review replies turn off on ${short}`, text, html };
  }
  const text = [
    "Your Replyr auto-reply is off, so new Google reviews are going unanswered right now.",
    "",
    "Re-enable anytime from your settings and replies pick back up automatically — your account, voice, and settings are all still there:",
    "",
    settings,
    "",
    "— Replyr"
  ].join("\n");
  const html = [
    `<p>Your Replyr auto-reply is off, so new Google reviews are going unanswered right now.</p>`,
    `<p><a href="${escapeHtml(settings)}">Re-enable anytime</a> and replies pick back up automatically — your account, voice, and settings are all still there.</p>`,
    `<p>— Replyr</p>`
  ].join("\n");
  return { subject: WINBACK_OFF_SUBJECT, text, html };
}

// --- Senders (never throw) ------------------------------------------------------

async function sendViaResend({ to, subject, text, html, logger, env = process.env, send }) {
  try {
    const recipient = oneLine(to);
    if (!recipient) return { sent: false, reason: "no-recipient" };
    const apiKey = (env.RESEND_API_KEY ?? "").trim();
    if (!apiKey && !send) return { sent: false, reason: "no-resend-key" };
    const from = (env.ALERT_FROM_EMAIL ?? "").trim() || "Replyr <onboarding@resend.dev>";
    const message = { from, to: [recipient], subject, text, html };
    if (send) {
      await send(message);
    } else {
      const { Resend } = await import("resend");
      const { error } = await new Resend(apiKey).emails.send(message);
      if (error) throw new Error(error.message);
    }
    return { sent: true };
  } catch (err) {
    logger?.warn?.({ err }, "Lifecycle email failed");
    return { sent: false, reason: "error" };
  }
}

/** Send the free-replies nudge to the business's notification email. */
export async function sendFreeRepliesNudgeEmail({ to, business, logger = console, env = process.env, send } = {}) {
  const { subject, text, html } = buildFreeRepliesNudgeEmail({
    accountId: business?.accountId,
    freeRepliesUsed: business?.freeRepliesUsed,
    settingsUrl: settingsUrlFor(business?.accountId, env)
  });
  return sendViaResend({ to, subject, text, html, logger, env, send });
}

/** Send the trial-ending reminder to the business's notification email. */
export async function sendTrialEndingEmail({ to, business, logger = console, env = process.env, send, now = new Date() } = {}) {
  const { subject, text, html } = buildTrialEndingEmail({
    accountId: business?.accountId,
    trialEndsAt: business?.trialEndsAt,
    settingsUrl: settingsUrlFor(business?.accountId, env),
    now
  });
  return sendViaResend({ to, subject, text, html, logger, env, send });
}

/** Send the winback email to the business's notification email. */
export async function sendWinbackEmail({ to, business, logger = console, env = process.env, send, now = new Date() } = {}) {
  const { subject, text, html } = buildWinbackEmail({
    accountId: business?.accountId,
    accessEndsAt: business?.subAccessEndsAt,
    settingsUrl: settingsUrlFor(business?.accountId, env),
    now
  });
  return sendViaResend({ to, subject, text, html, logger, env, send });
}

// --- Runner ---------------------------------------------------------------------

/** True during owner-friendly hours: 9:00–17:59 in America/Los_Angeles. */
export function isLifecycleSendWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hour12: false
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return hour >= 9 && hour < 18;
}

const STAMP_FIELD_BY_TYPE = {
  free_replies_nudge: "trialNudgeSentAt",
  trial_ending: "trialEndingSentAt",
  winback: "winbackSentAt"
};

const SENDER_BY_TYPE = {
  free_replies_nudge: sendFreeRepliesNudgeEmail,
  trial_ending: sendTrialEndingEmail,
  winback: sendWinbackEmail
};

/**
 * Scheduler entry point (hourly tick). Self-gates to 9am–6pm Pacific so
 * owners don't get nudges at 3am. For each due account: resolve the
 * notification email (skip silently when absent), send, and only on success
 * stamp the *_sent_at field on every location row of the account.
 *
 * `deps` is injectable for tests.
 */
export async function runLifecycleEmails(logger = console, { now = new Date(), deps = {} } = {}) {
  if (!isLifecycleSendWindow(now)) return { sent: 0, skipped: 0, reason: "outside-window" };
  const loadAll = deps.getAllBusinesses || getAllBusinesses;
  let businessesObj;
  try {
    businessesObj = await loadAll();
  } catch (err) {
    logger?.error?.({ err }, "Lifecycle emails: failed to list businesses");
    return { sent: 0, skipped: 0, reason: "list-failed" };
  }
  const businesses = Object.values(businessesObj || {});
  const picks = selectLifecycleEmails(businesses, now);
  const loadRows = deps.getBusinessesForAccount || getBusinessesForAccount;
  const stamp = deps.upsertBusiness || upsertBusiness;
  let sent = 0;
  let skipped = 0;
  for (const pick of picks) {
    try {
      const rows = await loadRows(pick.accountId);
      const primary = (rows && rows[0]) || businesses.find((b) => b.accountId === pick.accountId);
      const to = (primary?.notificationEmail || "").trim();
      if (!to) {
        skipped += 1;
        continue;
      }
      const sender = deps[`send_${pick.type}`] || SENDER_BY_TYPE[pick.type];
      const result = await sender({ to, business: primary, logger, now, send: deps.send, env: deps.env });
      if (!result?.sent) {
        skipped += 1;
        continue;
      }
      const stampIso = now.toISOString();
      const stampRows = rows && rows.length ? rows : [primary];
      for (const row of stampRows) {
        if (row) {
          await stamp({
            accountId: row.accountId,
            locationId: row.locationId,
            [STAMP_FIELD_BY_TYPE[pick.type]]: stampIso
          });
        }
      }
      sent += 1;
      logger?.info?.({ accountId: pick.accountId, type: pick.type }, "Lifecycle email sent");
    } catch (err) {
      logger?.error?.({ err, accountId: pick.accountId, type: pick.type }, "Lifecycle email failed for account");
      skipped += 1;
    }
  }
  return { sent, skipped };
}
