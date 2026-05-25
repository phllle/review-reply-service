/**
 * "Reply ready" email: sent when a reply is queued in delayed mode.
 * Includes a cancel link signed with the session secret.
 */

import { createCancelToken } from "./replyDelay.js";

const FROM_EMAIL = process.env.ALERT_FROM_EMAIL?.trim() || "Replyr <onboarding@resend.dev>";
function baseUrl() {
  return ((process.env.BASE_URL || "").trim() || "http://localhost:3000").replace(/\/$/, "");
}

function getSecret() {
  return (process.env.REPLYR_SESSION_SECRET || "").trim();
}

export function isPreviewEmailConfigured() {
  return Boolean((process.env.RESEND_API_KEY || "").trim()) && Boolean(getSecret());
}

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => d[c]);
}

/**
 * Send the preview email to the business owner. Throws if Resend isn't configured.
 * @param {object} args
 * @param {string} args.toEmail
 * @param {string} args.businessName
 * @param {string} args.accountId
 * @param {string} args.locationId
 * @param {string} args.reviewId
 * @param {number|null} args.rating
 * @param {string|null} args.reviewerName
 * @param {string|null} args.reviewComment
 * @param {string} args.generatedReply
 * @param {string} args.sendAfterIso
 */
export async function sendReplyPreviewEmail(args) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not set; cannot send preview email");
  const secret = getSecret();
  if (!secret) throw new Error("REPLYR_SESSION_SECRET is not set; cannot sign cancel token");

  const token = createCancelToken(args.accountId, args.locationId, args.reviewId, secret);
  const cancelUrl = `${baseUrl()}/auto-reply/cancel?token=${encodeURIComponent(token)}`;

  const ratingLabel = args.rating != null ? `${args.rating}-star` : "";
  const reviewer = args.reviewerName || "a customer";
  const reviewSnippet = (args.reviewComment || "").slice(0, 280);
  const sendAtLocal = formatPacific(args.sendAfterIso);

  const subject = `Reply ready to send for ${args.businessName || "your business"}`;
  const lines = [
    `${ratingLabel ? `${ratingLabel} ` : ""}review by ${reviewer}:`,
    reviewSnippet ? `"${reviewSnippet}"` : "(no comment)",
    "",
    `Replyr will post this at ${sendAtLocal}:`,
    "",
    args.generatedReply,
    "",
    `Cancel: ${cancelUrl}`,
    "",
    "— Replyr"
  ];
  const text = lines.join("\n");
  const html = `
<p><strong>${escapeHtml(ratingLabel)} review by ${escapeHtml(reviewer)}:</strong></p>
<blockquote style="margin:0 0 1em 0;padding:0.5em 1em;border-left:3px solid #ddd;color:#555;">${escapeHtml(reviewSnippet) || "<em>(no comment)</em>"}</blockquote>
<p>Replyr will post this at <strong>${escapeHtml(sendAtLocal)}</strong>:</p>
<blockquote style="margin:0 0 1em 0;padding:0.5em 1em;border-left:3px solid #4a90e2;">${escapeHtml(args.generatedReply).replace(/\n/g, "<br>")}</blockquote>
<p><a href="${escapeHtml(cancelUrl)}" style="display:inline-block;background:#c0392b;color:#fff;padding:0.5em 1em;border-radius:4px;text-decoration:none;">Cancel this reply</a></p>
<p style="font-size:0.8em;color:#888;">If the link doesn't work, paste this into your browser:<br>${escapeHtml(cancelUrl)}</p>
`;

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [args.toEmail],
    subject,
    text,
    html
  });
  if (error) throw new Error(error.message);
}

function formatPacific(iso) {
  if (!iso) return "soon";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      month: "short",
      day: "numeric"
    }).format(d);
  } catch {
    return iso;
  }
}
