/**
 * Replyr Pro: send campaign SMS (birthday, events, one-off) via Twilio.
 * CAMPAIGN_SMS_ENABLED must be true (plus Twilio env) for customer-facing campaign SMS.
 */

import * as db from "./db.js";
import { getBusiness } from "./businesses.js";
import { getCurrentMonthKey, getIncludedSmsForTier, normalizeProTier } from "./proPlan.js";

function getTwilioEnv() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || "",
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || "",
    fromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || ""
  };
}

function isTwilioEnvComplete() {
  const { accountSid, authToken, fromNumber } = getTwilioEnv();
  return !!accountSid && !!authToken && !!fromNumber;
}

/** Campaign SMS to customers: requires explicit opt-in env flag + Twilio. */
export function isCampaignSmsFeatureEnabled() {
  const flag = (process.env.CAMPAIGN_SMS_ENABLED || "false").trim().toLowerCase();
  const enabled = flag === "true" || flag === "1" || flag === "yes";
  return enabled && isTwilioEnvComplete();
}

/**
 * @deprecated use isCampaignSmsFeatureEnabled for Pro campaigns; use isTwilioEnvComplete for diagnostics
 */
function isSmsConfigured() {
  return isTwilioEnvComplete();
}

/**
 * Non-secret snapshot for debugging Railway env (use with TEST_ALERT_SECRET on the route).
 */
export function getCampaignSmsDiagnostics() {
  const { accountSid, authToken, fromNumber } = getTwilioEnv();
  const flag = (process.env.CAMPAIGN_SMS_ENABLED || "false").trim().toLowerCase();
  return {
    campaignSmsEnabledFlag: flag,
    campaignSmsFeatureEnabled: isCampaignSmsFeatureEnabled(),
    twilioAccountSidSet: accountSid.length > 0,
    twilioAuthTokenSet: authToken.length > 0,
    twilioFromNumberSet: fromNumber.length > 0,
    twilioFromLooksE164: /^\+\d{10,15}$/.test(fromNumber),
    isSmsConfigured: isSmsConfigured()
  };
}

/** Normalize US phone to E.164 (+1XXXXXXXXXX). Returns null if not valid. */
function normalizePhone(phone) {
  if (!phone || typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Low-level Twilio send (no quota). Use for operator /test-sms only.
 * @param {object} [options]
 * @param {boolean} [options.bypassCampaignSmsEnabled] - allow send when CAMPAIGN_SMS_ENABLED is false (tests, alerts path if shared)
 */
export async function sendCampaignSms(toPhone, body, options = {}) {
  const bypass = !!options.bypassCampaignSmsEnabled;
  if (!bypass && !isCampaignSmsFeatureEnabled()) return;
  if (!isTwilioEnvComplete()) return;
  const { accountSid, authToken, fromNumber } = getTwilioEnv();
  const to = normalizePhone(toPhone);
  if (!to) throw new Error("Invalid or unsupported phone number (need 10 or 11 digits)");
  const twilio = (await import("twilio")).default;
  const client = twilio(accountSid, authToken);
  await client.messages.create({
    body: (body || "").slice(0, 1600),
    from: fromNumber,
    to
  });
}

/**
 * Pro campaign SMS: checks feature flag, reserves one segment under monthly cap (atomic), sends, rolls back count on Twilio failure.
 * @returns {Promise<boolean>} true if sent
 */
export async function sendProCampaignSms(accountId, toPhone, body, logger = console) {
  if (!db.useDb()) {
    logger?.warn?.({ accountId }, "Campaign SMS skipped: database required for quota");
    return false;
  }
  if (!isCampaignSmsFeatureEnabled()) {
    logger?.warn?.({ accountId }, "Campaign SMS skipped: set CAMPAIGN_SMS_ENABLED=true and Twilio env vars");
    return false;
  }
  const business = await getBusiness(accountId);
  if (!business?.isPro) return false;
  const monthKey = getCurrentMonthKey();
  const cap = getIncludedSmsForTier(normalizeProTier(business.proTier));
  if (cap <= 0) return false;

  const newCount = await db.incrementProSmsUsageIfUnderCap(accountId, monthKey, cap);
  if (newCount == null) {
    logger?.warn?.({ accountId, cap }, "Campaign SMS skipped: monthly SMS limit reached");
    return false;
  }

  try {
    await sendCampaignSms(toPhone, body, { bypassCampaignSmsEnabled: true });
    return true;
  } catch (err) {
    await db.decrementProSmsUsage(accountId, monthKey, 1);
    throw err;
  }
}

export { isSmsConfigured };
