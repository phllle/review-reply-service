/**
 * Post-campaign summary email to the business OWNER (transactional receipt for a
 * send they just triggered). Reports submitted stats — contacts reached, email
 * vs SMS counts, SMS segments used, monthly quota remaining. Delivery/cost stats
 * are intentionally out of scope (Twilio reports those asynchronously).
 *
 * Sent for discrete campaigns (event, one-off). Birthday is a continuous daily
 * automation, so its activity is summarized in the weekly digest instead.
 */

import * as db from "./db.js";
import { getBusiness } from "./businesses.js";
import { getCurrentMonthKey, getIncludedSmsForTier, normalizeProTier } from "./proPlan.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL?.trim() || "Replyr <onboarding@resend.dev>";
const BASE_URL = ((process.env.BASE_URL || "").trim() || "http://localhost:3000").replace(/\/$/, "");

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => d[c]);
}

/**
 * Build the campaign report email. Pure/testable.
 * @param {object} opts - { businessName, campaignLabel, stats, quota, manageUrl }
 *   stats: { contactsTotal, emailSent, smsSent, smsAttempted, smsFailed }
 *   quota: { included, used, remaining } | null (null when SMS not used/available)
 */
export function buildCampaignReportEmail({ businessName = "your business", campaignLabel = "Your campaign", stats, quota, manageUrl }) {
  const s = stats || {};
  const subject = `${campaignLabel} sent — ${(s.emailSent || 0) + (s.smsSent || 0)} message${(s.emailSent || 0) + (s.smsSent || 0) === 1 ? "" : "s"} out`;

  const lines = [
    `${campaignLabel} just went out for ${businessName}.`,
    ``,
    `• ${s.emailSent || 0} email${s.emailSent === 1 ? "" : "s"} sent`,
    `• ${s.smsSent || 0} SMS sent`
  ];
  if (s.smsFailed > 0) {
    lines.push(`• ${s.smsFailed} SMS not sent (no quota left or send error)`);
  }
  lines.push(`• ${s.contactsTotal || 0} contacts in your list`);
  if (quota) {
    lines.push(``, `SMS this month: ${quota.used} of ${quota.included} used · ${quota.remaining} remaining`);
    if (quota.remaining <= 0) {
      lines.push(`You've hit your monthly SMS limit — SMS will resume next month or on a tier upgrade.`);
    }
  }
  lines.push(``, `Manage your account: ${manageUrl}`, ``, `— Replyr`);
  const text = lines.join("\n");

  const quotaHtml = quota
    ? `<p style="margin:16px 0 0;font-size:13px;color:#b8b6bf;">SMS this month: <strong style="color:#f0ede8;">${quota.used}</strong> of ${quota.included} used · <strong style="color:#f0ede8;">${quota.remaining}</strong> remaining${
        quota.remaining <= 0 ? `<br><span style="color:#f5a55c;">Monthly SMS limit reached — resumes next month or on upgrade.</span>` : ""
      }</p>`
    : "";
  const smsFailedHtml = s.smsFailed > 0 ? `<li><strong>${s.smsFailed}</strong> SMS not sent (no quota left or send error)</li>` : "";
  const html = `
<div style="max-width:520px;margin:0 auto;font-family:-apple-system,system-ui,sans-serif;background:#0f0f11;color:#f0ede8;padding:28px 24px;border-radius:16px;">
  <div style="font-size:15px;font-weight:700;margin-bottom:18px;">💬 Replyr</div>
  <p style="margin:0 0 14px;font-size:15px;"><strong>${escapeHtml(campaignLabel)}</strong> just went out for <strong>${escapeHtml(businessName)}</strong>.</p>
  <ul style="margin:0;padding-left:18px;color:#b8b6bf;line-height:1.8;font-size:14px;">
    <li><strong>${s.emailSent || 0}</strong> email${s.emailSent === 1 ? "" : "s"} sent</li>
    <li><strong>${s.smsSent || 0}</strong> SMS sent</li>
    ${smsFailedHtml}
    <li>${s.contactsTotal || 0} contacts in your list</li>
  </ul>
  ${quotaHtml}
  <p style="margin:22px 0 0;"><a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#4a9eff;color:#0f0f11;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px;font-size:14px;">Manage your account</a></p>
  <p style="margin-top:20px;font-size:12px;color:#7a7880;">— Replyr</p>
</div>`;
  return { subject, text, html };
}

async function sendOwnerEmail({ to, subject, text, html }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  const email = (to || "").trim().toLowerCase();
  if (!email) throw new Error("Missing owner email");
  const { Resend } = await import("resend");
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({ from: FROM_EMAIL, to: [email], subject, text, html });
  if (error) throw new Error(error.message);
  return { ok: true };
}

/**
 * Send a post-campaign report to the owner. Best-effort: logs and swallows on
 * failure so a report problem never breaks the campaign send path.
 * @param {object} opts - { business, campaignLabel, stats, logger }
 */
export async function sendCampaignReport({ business, campaignLabel, stats, logger = console }) {
  try {
    const ownerEmail = (business?.notificationEmail || "").trim();
    if (!ownerEmail || !RESEND_API_KEY) return { sent: false, reason: "no-email-or-resend" };

    // Only include a quota block if this campaign actually attempted SMS.
    let quota = null;
    if ((stats?.smsAttempted || 0) > 0 && db.useDb()) {
      const monthKey = getCurrentMonthKey();
      const included = getIncludedSmsForTier(normalizeProTier(business.proTier));
      const used = await db.getProSmsUsage(business.accountId, monthKey);
      quota = { included, used, remaining: Math.max(0, included - used) };
    }

    const manageUrl = `${BASE_URL}/connected?accountId=${encodeURIComponent(business.accountId)}`;
    const { subject, text, html } = buildCampaignReportEmail({
      businessName: business.name || "your business",
      campaignLabel,
      stats,
      quota,
      manageUrl
    });
    await sendOwnerEmail({ to: ownerEmail, subject, text, html });
    logger?.info?.({ accountId: business.accountId, campaignLabel }, "Campaign report sent");
    return { sent: true };
  } catch (err) {
    logger?.error?.({ err, accountId: business?.accountId }, "Campaign report failed (non-fatal)");
    return { sent: false, reason: "error" };
  }
}
