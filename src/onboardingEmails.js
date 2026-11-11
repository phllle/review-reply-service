/**
 * Onboarding emails (kit §13 Fixes 3 + 4).
 *
 * Fix 3 — welcome email, sent at connect: tells the new customer exactly
 * what Replyr will do before it does it. (The first paying customer was
 * surprised when auto-replies started posting; this email exists so that
 * never happens again.)
 *
 * Fix 4 — first-reply email, sent when the account's first auto-reply
 * actually posts: shows the owner the review and the reply that went live.
 * Doubles as a retention device — a triallist who sees a great reply on
 * day 1 converts.
 *
 * Copy is the kit's, verbatim, signed "Replyr" (never a personal name).
 * Same shape as signupNotify: pure builders (testable), senders that never
 * throw and report { sent, reason } instead.
 */

function baseUrl(env = process.env) {
  return ((env.BASE_URL || "").trim() || "http://localhost:3000").replace(/\/$/, "");
}

export function settingsUrlFor(accountId, env = process.env) {
  return `${baseUrl(env)}/connected?accountId=${encodeURIComponent(accountId || "")}#settings`;
}

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => d[c]);
}

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

// --- Fix 3: welcome email ----------------------------------------------------

export const WELCOME_SUBJECT = "You're connected — here's exactly what Replyr will do";

/** Pure: build the welcome email (subject + text + html). */
export function buildWelcomeEmail({ accountId, settingsUrl } = {}) {
  const settings = settingsUrl || settingsUrlFor(accountId);
  const items = [
    ["Your first 5 replies are free.", "We'll reply to your latest unreplied reviews so you can see your voice in action."],
    ["New reviews get replies automatically", "— written in your voice, posted as your business (Owner)."],
    ["Low-star reviews wait for you first.", "Preview mode is on: 1–3 star replies are held for 15 minutes and emailed to you with a one-click cancel link."],
    ["You're always in control.", "Pause replies, change your voice settings, or cancel anytime from your dashboard — cancellation takes two clicks, no emails to support required."],
    ["Your trial runs 30 days.", "No card on file, nothing charged today. After the trial it's $19/month if you stay."]
  ];
  const text = [
    "Hi — welcome to Replyr. Your Google Business Profile is connected, so here's precisely what happens next, no surprises:",
    "",
    ...items.map(([lead, rest], i) => `${i + 1}. ${lead} ${rest}`),
    "",
    `Want to see your settings? → ${settings}`,
    "Questions? Just reply to this email.",
    "",
    "— Replyr"
  ].join("\n");
  const html = [
    `<p>Hi — welcome to Replyr. Your Google Business Profile is connected, so here's precisely what happens next, no surprises:</p>`,
    `<ol>`,
    ...items.map(([lead, rest]) => `<li><strong>${escapeHtml(lead)}</strong> ${escapeHtml(rest)}</li>`),
    `</ol>`,
    `<p>Want to see your settings? → <a href="${escapeHtml(settings)}">Your reply settings</a></p>`,
    `<p>Questions? Just reply to this email.</p>`,
    `<p>— Replyr</p>`
  ].join("\n");
  return { subject: WELCOME_SUBJECT, text, html };
}

// --- Fix 4: first-reply email --------------------------------------------------

export const FIRST_REPLY_SUBJECT = "Your first Replyr reply just posted";

export function starsLabel(rating) {
  const n = Number(rating);
  if (!Number.isFinite(n) || n < 1 || n > 5) return "";
  const full = Math.round(n);
  return "★".repeat(full) + "☆".repeat(5 - full);
}

/** Pure: build the first-reply notification email (subject + text + html). */
export function buildFirstReplyEmail({ reviewerName, rating, reviewText, replyText, reviewUrl, settingsUrl } = {}) {
  const reviewer = oneLine(reviewerName) || "A customer";
  const stars = starsLabel(rating);
  const review = oneLine(reviewText);
  const reply = String(replyText ?? "").trim();
  const text = [
    "Your first automatic reply is live on Google. Here's what we posted:",
    "",
    `${reviewer}${stars ? ` ${stars}` : ""} — "${review}"`,
    `Your reply (as Owner): "${reply}"`,
    "",
    `See it on Google: ${reviewUrl || ""}`,
    `Adjust my voice/settings: ${settingsUrl || ""}`,
    "",
    "This is how every new review will be handled. Low-star replies still wait for your approval first while preview mode is on.",
    "",
    "— Replyr"
  ].join("\n");
  const html = [
    `<p>Your first automatic reply is live on Google. Here's what we posted:</p>`,
    `<blockquote style="margin:0 0 1em 0;padding:0.5em 1em;border-left:3px solid #ddd;color:#555;"><strong>${escapeHtml(reviewer)}</strong>${stars ? ` ${escapeHtml(stars)}` : ""} — "${escapeHtml(review)}"</blockquote>`,
    `<p><strong>Your reply (as Owner):</strong></p>`,
    `<blockquote style="margin:0 0 1em 0;padding:0.5em 1em;border-left:3px solid #4a90e2;">${escapeHtml(reply).replace(/\n/g, "<br>")}</blockquote>`,
    `<p>${reviewUrl ? `<a href="${escapeHtml(reviewUrl)}">See it on Google</a> · ` : ""}<a href="${escapeHtml(settingsUrl || "")}">Adjust my voice/settings</a></p>`,
    `<p>This is how every new review will be handled. Low-star replies still wait for your approval first while preview mode is on.</p>`,
    `<p>— Replyr</p>`
  ].join("\n");
  return { subject: FIRST_REPLY_SUBJECT, text, html };
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
    logger?.warn?.({ err }, "Onboarding email failed");
    return { sent: false, reason: "error" };
  }
}

/** Send the Fix 3 welcome email. `to` is the owner's email from OAuth. */
export async function sendWelcomeEmail({ to, accountId, logger = console, env = process.env, send } = {}) {
  const { subject, text, html } = buildWelcomeEmail({ accountId, settingsUrl: settingsUrlFor(accountId, env) });
  return sendViaResend({ to, subject, text, html, logger, env, send });
}

/** Send the Fix 4 first-reply email to the business's notification email. */
export async function sendFirstReplyEmail({ to, accountId, reviewerName, rating, reviewText, replyText, reviewUrl, logger = console, env = process.env, send } = {}) {
  const { subject, text, html } = buildFirstReplyEmail({
    reviewerName,
    rating,
    reviewText,
    replyText,
    reviewUrl,
    settingsUrl: settingsUrlFor(accountId, env)
  });
  return sendViaResend({ to, subject, text, html, logger, env, send });
}
