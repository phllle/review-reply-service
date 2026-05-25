/**
 * Pure helpers for the auto-reply preview/delay feature.
 *
 * "instant" mode: post replies immediately (current behavior).
 * "delayed" mode: low-star replies (<= AUTO_REPLY_DELAY_MAX_STAR) are queued
 * and emailed to the business with a cancel link. High-star replies still
 * post instantly so a happy customer's "Thanks!" never gets stuck waiting.
 */

import crypto from "crypto";

export const VALID_MODES = ["instant", "delayed"];
export const DEFAULT_MODE = "instant";

/** Max stars that get delayed when mode is "delayed". 1-3 = negative-ish; 4-5 still post instantly. */
export const DEFAULT_DELAY_MAX_STAR = 3;

/** Default delay before a queued reply auto-posts, in minutes. */
export const DEFAULT_DELAY_MINUTES = 15;

export function normalizeMode(value) {
  const v = String(value || "").trim().toLowerCase();
  return VALID_MODES.includes(v) ? v : DEFAULT_MODE;
}

export function getDelayMaxStar(env = process.env) {
  const raw = Number(env.AUTO_REPLY_DELAY_MAX_STAR);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 5) return Math.floor(raw);
  return DEFAULT_DELAY_MAX_STAR;
}

export function getDelayMinutes(env = process.env) {
  const raw = Number(env.AUTO_REPLY_DELAY_MINUTES);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_DELAY_MINUTES;
}

/**
 * Decide whether a generated reply should be queued or posted immediately.
 * @param {object} args
 * @param {string} args.mode             — business's autoReplyMode ("instant" | "delayed")
 * @param {number|null} args.rating      — 1-5, or null if unknown
 * @param {boolean} args.businessHasEmail — false disables delayed (we can't notify them)
 * @param {boolean} args.resendConfigured — false disables delayed (we can't send the email)
 * @param {object} [args.env]            — defaults to process.env (for testability)
 * @returns {"instant"|"delayed"}
 */
export function shouldDelayReply({ mode, rating, businessHasEmail, resendConfigured, env }) {
  if (normalizeMode(mode) !== "delayed") return "instant";
  if (!businessHasEmail || !resendConfigured) return "instant";
  if (rating == null) return "instant";
  const maxStar = getDelayMaxStar(env);
  return rating <= maxStar ? "delayed" : "instant";
}

/**
 * Sign a cancel token. Encodes accountId + locationId + reviewId so a leaked
 * token can only cancel its own reply (never escalate to other businesses).
 */
export function createCancelToken(accountId, locationId, reviewId, secret) {
  if (!secret) throw new Error("createCancelToken: secret is required");
  const payload = `cancel|${accountId}|${locationId}|${reviewId}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return Buffer.from(`${payload}|${sig}`, "utf8").toString("base64url");
}

/**
 * @returns {{ accountId: string, locationId: string, reviewId: string }|null}
 */
export function verifyCancelToken(token, secret) {
  if (!token || !secret) return null;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split("|");
    if (parts.length !== 5 || parts[0] !== "cancel") return null;
    const [, accountId, locationId, reviewId, sig] = parts;
    if (!accountId || !locationId || !reviewId || !sig) return null;
    const payload = `cancel|${accountId}|${locationId}|${reviewId}`;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return { accountId, locationId, reviewId };
  } catch {
    return null;
  }
}
