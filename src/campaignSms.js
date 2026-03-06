/**
 * Replyr Pro: send campaign SMS (birthday, events, one-off) via Twilio.
 * Set CAMPAIGN_SMS_ENABLED=true and Twilio env vars to enable.
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID?.trim();
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim();
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER?.trim();
const CAMPAIGN_SMS_ENABLED = process.env.CAMPAIGN_SMS_ENABLED === "true" || process.env.CAMPAIGN_SMS_ENABLED === "1";

function isSmsConfigured() {
  return CAMPAIGN_SMS_ENABLED && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER;
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
 * Send one campaign SMS. Body should be short (e.g. under 160 chars for single segment).
 * @param {string} toPhone - Recipient phone (any format; normalized to E.164)
 * @param {string} body - Message text
 * @returns {Promise<void>}
 */
export async function sendCampaignSms(toPhone, body) {
  if (!isSmsConfigured()) return;
  const to = normalizePhone(toPhone);
  if (!to) throw new Error("Invalid or unsupported phone number (need 10 or 11 digits)");
  const twilio = (await import("twilio")).default;
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.messages.create({
    body: (body || "").slice(0, 1600),
    from: TWILIO_FROM_NUMBER,
    to
  });
}

export { isSmsConfigured };
