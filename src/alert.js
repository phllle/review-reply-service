/**
 * Failure alerts: email (Resend) and/or SMS (Twilio) when auto-reply run fails.
 * Set ALERT_EMAIL and/or ALERT_PHONE to receive alerts.
 */

const ALERT_EMAIL = process.env.ALERT_EMAIL?.trim();
const ALERT_PHONE = process.env.ALERT_PHONE?.trim();
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL?.trim() || "Replyr <onboarding@resend.dev>";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID?.trim();
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim();
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER?.trim();

/**
 * Send failure alert to configured email and/or phone.
 * @param {object} opts - { businessName?, accountId?, error?, result? }
 */
export async function sendFailureAlert(opts = {}) {
  const { businessName = "Unknown", accountId = "", error, result } = opts;
  const businessLabel = businessName || accountId || "Unknown business";
  let subject = "Replyr: auto-reply failed";
  let body = `Replyr auto-reply failed for ${businessLabel}`;
  if (accountId) body += ` (${accountId})`;
  body += ".\n\n";
  if (error) {
    subject = "Replyr: auto-reply error";
    body += `Error: ${error.message || String(error)}\n`;
  }
  if (result && (result.failed > 0 || result.details?.length)) {
    body += `Attempted: ${result.attempted ?? 0}, succeeded: ${result.succeeded ?? 0}, failed: ${result.failed ?? 0}.\n`;
    const errDetail = result.details?.find((d) => d.status === "error" && d.message);
    if (errDetail) body += `Reason: ${errDetail.message}\n`;
  }
  body += `\nTime: ${new Date().toISOString()}`;

  const shortMsg = error
    ? `Replyr error (${businessLabel}): ${(error.message || String(error)).slice(0, 80)}`
    : `Replyr: ${result?.failed ?? 0} reply failed for ${businessLabel}. Check email.`;

  const promises = [];
  if (ALERT_EMAIL && RESEND_API_KEY) {
    promises.push(sendEmail(subject, body).catch((e) => console.error("Alert email failed:", e.message)));
  }
  if (ALERT_PHONE && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
    promises.push(sendSms(shortMsg).catch((e) => console.error("Alert SMS failed:", e.message)));
  }
  await Promise.allSettled(promises);
}

async function sendEmail(subject, text) {
  if (!ALERT_EMAIL) return;
  if (!RESEND_API_KEY) return;
  const { Resend } = await import("resend");
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [ALERT_EMAIL],
    subject,
    text
  });
  if (error) throw new Error(error.message);
}

async function sendSms(text) {
  if (!ALERT_PHONE || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) return;
  const twilio = (await import("twilio")).default;
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.messages.create({
    body: text.slice(0, 1600),
    from: TWILIO_FROM_NUMBER,
    to: ALERT_PHONE
  });
}
