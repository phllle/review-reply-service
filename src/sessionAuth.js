/**
 * Signed browser session (Google accountId) + admin secret helpers.
 * Uses HttpOnly cookie; no server-side session store.
 */

import crypto from "crypto";

const COOKIE_NAME = "replyr_session";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

function getSessionSecret() {
  const s = process.env.REPLYR_SESSION_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("REPLYR_SESSION_SECRET is required in production");
  }
  return "dev-replyr-session-secret-change-me";
}

function hmac(data) {
  return crypto.createHmac("sha256", getSessionSecret()).update(data).digest("base64url");
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @returns {string|null} accountId if cookie is valid and not expired
 */
export function readSessionAccountId(req) {
  try {
    const cookies = parseCookies(req);
    const val = cookies[COOKIE_NAME];
    if (!val || typeof val !== "string") return null;
    const dot = val.lastIndexOf(".");
    if (dot === -1) return null;
    const payloadB64 = val.slice(0, dot);
    const sig = val.slice(dot + 1);
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    if (hmac(payload) !== sig) return null;
    const pipe = payload.indexOf("|");
    if (pipe === -1) return null;
    const accountId = payload.slice(0, pipe);
    const exp = parseInt(payload.slice(pipe + 1), 10);
    if (!accountId || Number.isNaN(exp) || Date.now() > exp) return null;
    return accountId;
  } catch {
    return null;
  }
}

/**
 * @param {import("express").Response} res
 * @param {string} accountId
 */
export function setSessionCookie(res, accountId) {
  const exp = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const payload = `${accountId}|${exp}`;
  const token = `${Buffer.from(payload, "utf8").toString("base64url")}.${hmac(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`
  );
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

/** Constant-time string compare. Hash both sides with sha256 so length isn't leaked. */
function timingSafeEqualStr(a, b) {
  const ah = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const bh = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** Admin secret from headers ONLY — never query strings. */
export function getAdminSecretFromRequest(req) {
  const header =
    (req.headers["x-admin-secret"] && String(req.headers["x-admin-secret"])) ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "");
  return header.trim();
}

// Admin session cookie: set after a correct secret is POSTed to /admin/login.
// Bound to a hash of the CURRENT ADMIN_SECRET so rotating the secret
// immediately invalidates outstanding admin cookies.
const ADMIN_COOKIE_NAME = "replyr_admin";
const ADMIN_MAX_AGE_SEC = 12 * 60 * 60; // 12h

function adminSecretFingerprint() {
  const expected = process.env.ADMIN_SECRET?.trim();
  if (!expected) return null;
  return crypto.createHash("sha256").update(expected).digest("base64url").slice(0, 16);
}

export function setAdminCookie(res) {
  const fp = adminSecretFingerprint();
  if (!fp) return;
  const exp = Date.now() + ADMIN_MAX_AGE_SEC * 1000;
  const payload = `admin|${fp}|${exp}`;
  const token = `${Buffer.from(payload, "utf8").toString("base64url")}.${hmac(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_MAX_AGE_SEC}${secure}`
  );
}

export function clearAdminCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append("Set-Cookie", `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function hasValidAdminCookie(req) {
  const fp = adminSecretFingerprint();
  if (!fp) return false;
  const val = parseCookies(req)[ADMIN_COOKIE_NAME];
  if (!val || typeof val !== "string") return false;
  const dot = val.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = Buffer.from(val.slice(0, dot), "base64url").toString("utf8");
  if (hmac(payload) !== val.slice(dot + 1)) return false;
  const parts = payload.split("|");
  if (parts.length !== 3 || parts[0] !== "admin" || parts[1] !== fp) return false;
  const exp = parseInt(parts[2], 10);
  if (Number.isNaN(exp) || Date.now() > exp) return false;
  return true;
}

/** True if the POSTed secret matches ADMIN_SECRET (constant-time). For /admin/login. */
export function isAdminSecretValid(secret) {
  const expected = process.env.ADMIN_SECRET?.trim();
  if (!expected) return false;
  return timingSafeEqualStr(secret, expected);
}

export function isValidAdminRequest(req) {
  const expected = process.env.ADMIN_SECRET?.trim();
  if (!expected) return false;
  const header = getAdminSecretFromRequest(req);
  if (header && timingSafeEqualStr(header, expected)) return true;
  return hasValidAdminCookie(req);
}

export function requireAdminOr401(req, res) {
  if (isValidAdminRequest(req)) return true;
  res.status(401).json({ error: "Unauthorized. Sign in at /admin or send the X-Admin-Secret header." });
  return false;
}

/**
 * Auth for the dev-only /test-* senders. Header only — never query strings.
 * Accepts X-Admin-Secret (== ADMIN_SECRET) or X-Test-Secret (== TEST_ALERT_SECRET).
 */
export function isValidTestRequest(req) {
  const adminExpected = process.env.ADMIN_SECRET?.trim();
  const adminHeader = getAdminSecretFromRequest(req);
  if (adminExpected && adminHeader && timingSafeEqualStr(adminHeader, adminExpected)) return true;
  const testExpected = process.env.TEST_ALERT_SECRET?.trim();
  const testHeader = req.headers["x-test-secret"] && String(req.headers["x-test-secret"]).trim();
  if (testExpected && testHeader && timingSafeEqualStr(testHeader, testExpected)) return true;
  return false;
}

/** @returns {boolean} true if caller may act as accountId (session or admin) */
export function canAccessAccount(req, accountId) {
  if (!accountId) return false;
  if (isValidAdminRequest(req)) return true;
  const sid = readSessionAccountId(req);
  return sid === accountId;
}

const CHOOSE_LOC_TTL_MS = 15 * 60 * 1000;

/** Short-lived token for POST /auth/choose-location (after OAuth, before session cookie). */
export function signChooseLocationToken(accountId) {
  const exp = Date.now() + CHOOSE_LOC_TTL_MS;
  const payload = `choose|${accountId}|${exp}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${hmac(payload)}`;
}

/** @returns {string|null} accountId */
export function verifyChooseLocationToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  if (hmac(payload) !== sig) return null;
  const parts = payload.split("|");
  if (parts.length !== 3 || parts[0] !== "choose") return null;
  const accountId = parts[1];
  const exp = parseInt(parts[2], 10);
  if (!accountId || Number.isNaN(exp) || Date.now() > exp) return null;
  return accountId;
}
