/**
 * First-reply hook (kit §7 `first_reply_posted` + §13 Fix 4).
 *
 * Called from the reply flow right after a reply actually posts to Google.
 * Exactly once per account: the first call claims `firstReplyAt` on the
 * business record, fires the GA4 event via Measurement Protocol, and sends
 * the owner the "your first reply just posted" email. Later calls see the
 * claim and no-op.
 *
 * Never throws — a broken hook must not fail a reply that already posted.
 * `deps` is injectable for tests.
 */

import { getBusinessesForAccount, upsertBusiness } from "./businesses.js";
import { fireFirstReplyPosted } from "./gaEvents.js";
import { sendFirstReplyEmail } from "./onboardingEmails.js";

/**
 * Maps deep link for a business, in Google Maps URL API format: a name query
 * plus query_place_id pins the exact listing. The previous
 * /maps/place/?q=place_id:<id> form was treated by Maps (especially mobile
 * web) as a literal text search and showed "No results found" even though
 * the reply had posted fine. Fallbacks: name-only search when the place id
 * is missing, place-id-only when the name is missing, null when both are.
 */
export function googlePlaceUrl(placeId, businessName) {
  const id = String(placeId || "").trim();
  const name = String(businessName || "").trim();
  if (id && name) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(id)}`;
  }
  if (name) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
  }
  if (id) {
    return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(id)}`;
  }
  return null;
}

export async function handleFirstReplyPosted({
  accountId,
  locationId = "",
  reviewerName = null,
  rating = null,
  reviewText = null,
  replyText = null,
  logger = console,
  env = process.env,
  deps = {}
} = {}) {
  try {
    if (!accountId) return { fired: false, reason: "no-account" };
    const loadRows = deps.getBusinessesForAccount || getBusinessesForAccount;
    const rows = await loadRows(accountId);
    if (!rows || !rows.length) return { fired: false, reason: "no-business" };
    if (rows.some((r) => r.firstReplyAt)) return { fired: false, reason: "already-fired" };
    const primary = rows.find((r) => r.locationId === (locationId || "")) || rows[0];

    // Claim first, before any side effect, so a crash mid-hook can't
    // double-fire on the next reply.
    const claim = deps.upsertBusiness || upsertBusiness;
    await claim({ ...primary, firstReplyAt: new Date().toISOString() });

    const fire = deps.fireFirstReplyPosted || fireFirstReplyPosted;
    Promise.resolve(fire(primary, { logger })).catch(() => {});

    const send = deps.sendFirstReplyEmail || sendFirstReplyEmail;
    const email = await send({
      to: primary.notificationEmail || null,
      accountId,
      reviewerName,
      rating,
      reviewText,
      replyText,
      reviewUrl: googlePlaceUrl(primary.placeId, primary.name),
      logger,
      env
    });
    return { fired: true, email };
  } catch (err) {
    logger?.warn?.({ err, accountId }, "First-reply hook failed");
    return { fired: false, reason: "error" };
  }
}
