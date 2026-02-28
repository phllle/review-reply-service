/**
 * Replyr Pro: send campaign emails (birthday, events, one-off) via Resend.
 * Includes unsubscribe link (signed token) and physical address in footer for compliance.
 */

import crypto from "crypto";

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL?.trim() || "Replyr <onboarding@resend.dev>";
const BASE_URL = (process.env.BASE_URL || "").trim() || "http://localhost:3000";
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET?.trim() || process.env.RESEND_API_KEY || "replyr-unsubscribe";
const FOOTER_ADDRESS = process.env.CAMPAIGN_FOOTER_ADDRESS?.trim() || process.env.REPLYR_ADDRESS?.trim() || "";

/**
 * Create a signed token for unsubscribe link (accountId + email). Verify with verifyUnsubscribeToken.
 */
export function createUnsubscribeToken(accountId, email) {
  const payload = `${accountId}:${(email || "").trim().toLowerCase()}`;
  const sig = crypto.createHmac("sha256", UNSUBSCRIBE_SECRET).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

/**
 * Verify token and return { accountId, email } or null if invalid.
 */
export function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [accountId, email, sig] = decoded.split(":");
    if (!accountId || !email || !sig) return null;
    const payload = `${accountId}:${email}`;
    const expected = crypto.createHmac("sha256", UNSUBSCRIBE_SECRET).update(payload).digest("base64url");
    if (sig !== expected) return null;
    return { accountId, email };
  } catch {
    return null;
  }
}

/**
 * Build plain-text and HTML body with footer: unsubscribe link + physical address.
 */
export function buildCampaignBody(bodyContent, businessName, unsubscribeToken) {
  const unsubUrl = `${BASE_URL.replace(/\/$/, "")}/pro/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
  const footer = [
    "",
    "—",
    `You received this from ${businessName} via Replyr.`,
    `Unsubscribe: ${unsubUrl}`,
    ...(FOOTER_ADDRESS ? [FOOTER_ADDRESS] : [])
  ].join("\n");
  const text = bodyContent + footer;
  const html = `
${bodyContent.replace(/\n/g, "<br>\n")}
<p style="margin-top:1.5em;font-size:0.85em;color:#666;">—<br>
You received this from ${escapeHtml(businessName)} via Replyr.<br>
<a href="${escapeHtml(unsubUrl)}">Unsubscribe</a> from ${escapeHtml(businessName)} emails.</p>
${FOOTER_ADDRESS ? `<p style="font-size:0.8em;color:#888;">${escapeHtml(FOOTER_ADDRESS)}</p>` : ""}
`;
  return { text, html };
}

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => d[c]);
}

/**
 * Send one campaign email. Returns { ok: true } or throws.
 * to, subject, bodyContent (plain), businessName, accountId (for unsubscribe token), replyTo (optional).
 */
export async function sendCampaignEmail({ to, subject, bodyContent, businessName, accountId, replyTo }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set; cannot send campaign email");
  const email = (to || "").trim().toLowerCase();
  if (!email) throw new Error("Missing to email");
  const token = createUnsubscribeToken(accountId, email);
  const { text, html } = buildCampaignBody(bodyContent, businessName || "this business", token);
  const fromDisplay = businessName ? `${businessName} via Replyr` : "Replyr";
  const fromEmail = (FROM_EMAIL.match(/<([^>]+)>/)?.[1]) || "onboarding@resend.dev";
  const from = `${fromDisplay} <${fromEmail}>`;
  const { Resend } = await import("resend");
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from,
    to: [email],
    replyTo: replyTo || undefined,
    subject,
    text,
    html
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}
