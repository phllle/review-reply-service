/**
 * Ads attribution capture (kit §7 step 2).
 *
 * The marketing pages store first-touch click IDs (gclid + UTMs) in a
 * first-party cookie (`replyr_attr`, written by public/analytics.js). At
 * OAuth connect time the server reads that cookie and persists the values
 * onto the business record, so a later Stripe payment can be tied back to
 * the ad click that produced the signup. This is the piece that cannot be
 * retrofitted — months of unattributed payments would be lost forever.
 *
 * Pure helpers, no IO beyond reading the request's Cookie header.
 */

/** snake_case key (cookie/URL) -> camelCase business field. */
export const ATTRIBUTION_KEY_MAP = {
  gclid: "gclid",
  ga_client_id: "gaClientId",
  utm_source: "utmSource",
  utm_medium: "utmMedium",
  utm_campaign: "utmCampaign",
  landing_page: "landingPage"
};

export const ATTRIBUTION_COOKIE_NAME = "replyr_attr";

const MAX_VALUE_LENGTH = 512;

function cleanValue(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, MAX_VALUE_LENGTH);
  return s || null;
}

/**
 * Whitelist + normalize a raw attribution object (snake_case keys, e.g.
 * parsed cookie JSON or URL params). Returns a camelCase object containing
 * only the fields that have values, or null when nothing usable is present
 * (so callers can treat "no attribution" as a strict no-op).
 */
export function sanitizeAttribution(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [snake, camel] of Object.entries(ATTRIBUTION_KEY_MAP)) {
    const v = cleanValue(raw[snake]);
    if (v) out[camel] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Parse the JSON value of the replyr_attr cookie (already URI-decoded). */
export function parseAttributionCookieValue(value) {
  if (!value || typeof value !== "string") return null;
  let raw = value;
  try {
    raw = decodeURIComponent(value);
  } catch {
    /* not encoded — parse as-is */
  }
  try {
    return sanitizeAttribution(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Minimal Cookie-header reader (mirrors sessionAuth's parsing rules). */
export function readCookieValue(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const v = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

/**
 * Attribution captured for the visitor making this request, or null.
 * @param {import("express").Request} req
 */
export function attributionFromRequest(req) {
  const raw = readCookieValue(req?.headers?.cookie, ATTRIBUTION_COOKIE_NAME);
  return parseAttributionCookieValue(raw);
}
