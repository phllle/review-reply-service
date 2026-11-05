/**
 * Server-side GA4 events via the Measurement Protocol (kit §7 steps 3 + 5).
 *
 * Why server-side: client tags get eaten by ad-blockers and browser quirks;
 * the events that matter (trial_start, subscription_paid,
 * first_reply_posted) all originate in backend flows anyway (OAuth callback,
 * Stripe webhook, reply job). Each event carries the business's stored
 * ga_client_id so GA4 stitches it to the ad click that produced the signup,
 * and the stored gclid is attached as a parameter so a future Google Ads
 * API offline upload can reuse exactly this data.
 *
 * Everything here is best-effort and silent by design: when GA_MEASUREMENT_ID
 * or GA_API_SECRET is unset, sends are skipped; network failures are logged
 * and swallowed. Analytics must never break signup, billing, or replies.
 */

import crypto from "crypto";
import { getGaMeasurementId } from "./analytics.js";

const MP_ENDPOINT = "https://www.google-analytics.com/mp/collect";

/** Both halves of the Measurement Protocol credential pair are required. */
export function isGaEventsConfigured(env = process.env) {
  return Boolean(getGaMeasurementId(env) && (env.GA_API_SECRET || "").trim());
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/**
 * Pure: build a Measurement Protocol request body for one event.
 * `eventId` rides as an event parameter — the client-side backup event on
 * the post-connect page uses the same event_id (the account ID), which is
 * how GA4 deduplicates the pair.
 */
export function buildEventPayload({ clientId, userId = null, name, params = {}, eventId = null, userEmail = null }) {
  const eventParams = { engagement_time_msec: 1, ...params };
  if (eventId) eventParams.event_id = String(eventId);
  const payload = {
    client_id: clientId,
    events: [{ name, params: eventParams }]
  };
  if (userId) payload.user_id = String(userId);
  if (userEmail) {
    // Enhanced Conversions (kit §7 step 6): hashed, never raw.
    payload.user_data = { sha256_email_address: [sha256Hex(String(userEmail).trim().toLowerCase())] };
  }
  return payload;
}

/**
 * Send one event for a business. Never throws.
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendGaEvent({
  business,
  name,
  params = {},
  eventId = null,
  userEmail = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  try {
    if (!isGaEventsConfigured(env)) return { sent: false, reason: "not-configured" };
    const accountId = business?.accountId || null;
    // Prefer the real GA client ID captured at landing; fall back to a
    // stable synthetic ID so the event still lands in GA4 (unstitched).
    const clientId = business?.gaClientId || (accountId ? `replyr-${accountId}` : null);
    if (!clientId) return { sent: false, reason: "no-client-id" };
    const finalParams = { ...params };
    if (business?.gclid && !finalParams.gclid) finalParams.gclid = business.gclid;
    const body = buildEventPayload({
      clientId,
      userId: accountId,
      name,
      params: finalParams,
      eventId,
      userEmail
    });
    const url = `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(getGaMeasurementId(env))}&api_secret=${encodeURIComponent((env.GA_API_SECRET || "").trim())}`;
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (resp && resp.ok === false) {
      logger?.warn?.({ status: resp.status, event: name }, "GA4 Measurement Protocol send failed");
      return { sent: false, reason: `http-${resp.status}` };
    }
    return { sent: true };
  } catch (err) {
    logger?.warn?.({ err, event: name }, "GA4 Measurement Protocol send errored");
    return { sent: false, reason: "error" };
  }
}

/** Kit §7 PRIMARY conversion: OAuth completed + a location was attached. */
export function fireTrialStart(business, opts = {}) {
  return sendGaEvent({
    ...opts,
    business,
    name: "trial_start",
    params: { value: 19, currency: "USD", ...(opts.params || {}) },
    eventId: business?.accountId || null
  });
}

/**
 * Kit §7 money event: first successful payment. Amount is the actual amount
 * paid (Stripe cents in, GA value in dollars out).
 */
export function fireSubscriptionPaid(business, { amountCents = null, ...opts } = {}) {
  const params = { currency: "USD", ...(opts.params || {}) };
  if (typeof amountCents === "number" && Number.isFinite(amountCents)) {
    params.value = Math.round(amountCents) / 100;
  }
  return sendGaEvent({ ...opts, business, name: "subscription_paid", params });
}

/** Kit §7 quality signal + the trigger for the §13 first-reply email. */
export function fireFirstReplyPosted(business, opts = {}) {
  return sendGaEvent({
    ...opts,
    business,
    name: "first_reply_posted",
    eventId: business?.accountId || null
  });
}
