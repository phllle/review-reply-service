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

/** Maps deep link for a business, same pattern as the signup notification. */
export function googlePlaceUrl(placeId) {
  return placeId ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}` : null;
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
      reviewUrl: googlePlaceUrl(primary.placeId),
      logger,
      env
    });
    return { fired: true, email };
  } catch (err) {
    logger?.warn?.({ err, accountId }, "First-reply hook failed");
    return { fired: false, reason: "error" };
  }
}
