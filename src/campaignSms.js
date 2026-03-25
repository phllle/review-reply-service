/**
 * Replyr Pro: send campaign SMS (birthday, events, one-off) via Twilio.
 * SMS is enabled automatically whenever all three Twilio env vars are present.
 */

function getTwilioEnv() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || "",
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || "",
    fromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || ""
  };
}

function isSmsConfigured() {
  const { accountSid, authToken, fromNumber } = getTwilioEnv();
  return !!accountSid && !!authToken && !!fromNumber;
}

/**
 * Non-secret snapshot for debugging Railway env (use with TEST_ALERT_SECRET on the route).
 */
export function getCampaignSmsDiagnostics() {
  const { accountSid, authToken, fromNumber } = getTwilioEnv();
  return {
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
 * Send one campaign SMS. Body should be short (e.g. under 160 chars for single segment).
 * @param {string} toPhone - Recipient phone (any format; normalized to E.164)
 * @param {string} body - Message text
 * @returns {Promise<void>}
 */
export async function sendCampaignSms(toPhone, body) {
  if (!isSmsConfigured()) return;
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

export { isSmsConfigured };
