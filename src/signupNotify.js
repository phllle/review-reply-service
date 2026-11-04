/**
 * "New free-trial signup" email to the Replyr operator.
 *
 * Sent once when a Google account connects and gets its first businesses row
 * (i.e. a brand-new tenant starting the 30-day trial). Adding a second location
 * to an existing account, or a manager attaching to an existing business by
 * Place ID, does NOT trigger it.
 *
 * Recipient: SIGNUP_NOTIFY_EMAIL, falling back to ALERT_EMAIL. Set
 * SIGNUP_NOTIFY_EMAIL=off to disable. Needs RESEND_API_KEY. Best-effort:
 * never throws, never blocks the signup redirect.
 */

/** Resolve the operator inbox, or null when notifications are off/unconfigured. */
export function signupNotifyRecipient(env = process.env) {
  const raw = (env.SIGNUP_NOTIFY_EMAIL ?? "").trim();
  if (/^(off|false|0|none)$/i.test(raw)) return null;
  const to = raw || (env.ALERT_EMAIL ?? "").trim();
  return to || null;
}

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

/** Pure: build subject + plain-text body for a new trial signup. */
export function buildSignupEmail(business, { ownerEmail = null, now = new Date(), baseUrl = "https://replyr.pro" } = {}) {
  const name = oneLine(business?.name) || "Unnamed business";
  const subject = `New Replyr trial: ${name}`.slice(0, 200);
  const trialEnds = business?.trialEndsAt ? new Date(business.trialEndsAt) : null;
  const lines = [
    `A new business just connected Google and started a free trial.`,
    ``,
    `Business:   ${name}`,
    `Owner:      ${oneLine(ownerEmail) || "(no email from Google)"}`,
    `Account ID: ${oneLine(business?.accountId)}`,
    `Location:   ${oneLine(business?.locationId) || "—"}`
  ];
  if (business?.placeId) {
    lines.push(`Google:     https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(business.placeId)}`);
  }
  lines.push(
    `Trial ends: ${trialEnds && !isNaN(trialEnds.getTime()) ? trialEnds.toISOString().slice(0, 10) : "—"}`,
    `Signed up:  ${now.toISOString()}`,
    ``,
    `Admin: ${baseUrl}/admin`
  );
  return { subject, text: lines.join("\n") };
}

/**
 * Send the signup email. Returns { sent, reason }. Never throws.
 * @param {object} business - the newly created businesses row
 * @param {{ ownerEmail?: string|null, logger?: object, env?: object, send?: Function }} [opts]
 */
export async function notifyTrialSignup(business, { ownerEmail = null, logger = console, env = process.env, send } = {}) {
  try {
    const to = signupNotifyRecipient(env);
    if (!to) return { sent: false, reason: "no-recipient" };
    const apiKey = (env.RESEND_API_KEY ?? "").trim();
    if (!apiKey && !send) return { sent: false, reason: "no-resend-key" };
    const from = (env.ALERT_FROM_EMAIL ?? "").trim() || "Replyr <onboarding@resend.dev>";
    const { subject, text } = buildSignupEmail(business, { ownerEmail });
    const message = { from, to: [to], subject, text, ...(ownerEmail ? { reply_to: oneLine(ownerEmail) } : {}) };
    if (send) {
      await send(message);
    } else {
      const { Resend } = await import("resend");
      const { error } = await new Resend(apiKey).emails.send(message);
      if (error) throw new Error(error.message);
    }
    return { sent: true };
  } catch (err) {
    logger.warn?.({ err, accountId: business?.accountId }, "Trial signup email failed");
    return { sent: false, reason: "error" };
  }
}
