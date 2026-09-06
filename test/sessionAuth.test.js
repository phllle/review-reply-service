import { test } from "node:test";
import assert from "node:assert/strict";

process.env.REPLYR_SESSION_SECRET = "test-session-secret-aaaaa";
delete process.env.NODE_ENV;
delete process.env.ADMIN_SECRET;

const {
  setSessionCookie,
  readSessionAccountId,
  signChooseLocationToken,
  verifyChooseLocationToken,
  isValidAdminRequest,
  canAccessAccount,
  getAdminSecretFromRequest,
  isAdminSecretValid,
  setAdminCookie,
  isValidTestRequest
} = await import("../src/sessionAuth.js");

// Capture a Set-Cookie value and turn it into a request Cookie header.
function cookieHeaderFrom(setCookieValue) {
  return String(setCookieValue).split(";")[0];
}
function fakeResCapture() {
  const cookies = [];
  return { append: (_h, v) => cookies.push(v), cookies };
}

function fakeRes() {
  const headers = {};
  return {
    headers,
    append(key, value) {
      headers[key] = headers[key] ? [].concat(headers[key], value) : value;
    }
  };
}

function reqWithCookie(cookie) {
  return { headers: { cookie } };
}

function getSetCookieValue(res) {
  const sc = res.headers["Set-Cookie"];
  const raw = Array.isArray(sc) ? sc[0] : sc;
  // "replyr_session=<encoded>; Path=/; HttpOnly; ..."
  const m = raw.match(/^replyr_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

test("setSessionCookie + readSessionAccountId roundtrip", () => {
  const res = fakeRes();
  setSessionCookie(res, "1234567890");
  const token = getSetCookieValue(res);
  assert.ok(token, "expected Set-Cookie token to be present");
  // Build a request that carries that cookie.
  const req = reqWithCookie(`replyr_session=${encodeURIComponent(token)}`);
  assert.equal(readSessionAccountId(req), "1234567890");
});

test("readSessionAccountId rejects tampered payload", () => {
  const res = fakeRes();
  setSessionCookie(res, "real-account");
  const token = getSetCookieValue(res);
  const dot = token.lastIndexOf(".");
  const sig = token.slice(dot + 1);
  // Forge a payload claiming a different account but reuse the original signature.
  const forgedPayload = `attacker|${Date.now() + 60_000}`;
  const forged = `${Buffer.from(forgedPayload, "utf8").toString("base64url")}.${sig}`;
  const req = reqWithCookie(`replyr_session=${encodeURIComponent(forged)}`);
  assert.equal(readSessionAccountId(req), null);
});

test("readSessionAccountId rejects malformed cookie values", () => {
  assert.equal(readSessionAccountId({ headers: {} }), null);
  assert.equal(readSessionAccountId(reqWithCookie("replyr_session=garbage")), null);
  assert.equal(readSessionAccountId(reqWithCookie("replyr_session=no.dot.signature")), null);
});

test("signChooseLocationToken / verifyChooseLocationToken roundtrip", () => {
  const tok = signChooseLocationToken("acct-9");
  assert.equal(verifyChooseLocationToken(tok), "acct-9");
});

test("verifyChooseLocationToken rejects expired or wrong-prefix tokens", () => {
  // Tampered prefix
  const tok = signChooseLocationToken("acct-9");
  // Replace "choose" with "other" and re-sign manually — just ensure unsigned prefix swap fails.
  const dot = tok.lastIndexOf(".");
  const payloadB64 = tok.slice(0, dot);
  const sig = tok.slice(dot + 1);
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const tampered = payload.replace(/^choose/, "wrong");
  const tamperedB64 = Buffer.from(tampered, "utf8").toString("base64url");
  assert.equal(verifyChooseLocationToken(`${tamperedB64}.${sig}`), null);
});

test("isValidAdminRequest: false when ADMIN_SECRET unset, even if header sent", () => {
  delete process.env.ADMIN_SECRET;
  const req = { headers: { "x-admin-secret": "anything" }, query: {} };
  assert.equal(isValidAdminRequest(req), false);
});

test("isValidAdminRequest: header and bearer authorize; query does NOT", () => {
  process.env.ADMIN_SECRET = "shhh";
  assert.equal(isValidAdminRequest({ headers: { "x-admin-secret": "shhh" }, query: {} }), true);
  assert.equal(isValidAdminRequest({ headers: { authorization: "Bearer shhh" }, query: {} }), true);
  // Query strings must be ignored now.
  assert.equal(isValidAdminRequest({ headers: {}, query: { secret: "shhh" } }), false);
  assert.equal(isValidAdminRequest({ headers: {}, query: { adminSecret: "shhh" } }), false);
  assert.equal(isValidAdminRequest({ headers: { "x-admin-secret": "wrong" }, query: {} }), false);
  delete process.env.ADMIN_SECRET;
});

test("getAdminSecretFromRequest reads header only, ignores query", () => {
  assert.equal(
    getAdminSecretFromRequest({ headers: { "x-admin-secret": "from-header" }, query: { secret: "from-query" } }),
    "from-header"
  );
  assert.equal(getAdminSecretFromRequest({ headers: {}, query: { secret: "from-query" } }), "");
});

test("isAdminSecretValid: constant-time compare of POSTed secret", () => {
  delete process.env.ADMIN_SECRET;
  assert.equal(isAdminSecretValid("x"), false); // unset -> false
  process.env.ADMIN_SECRET = "correct-horse";
  assert.equal(isAdminSecretValid("correct-horse"), true);
  assert.equal(isAdminSecretValid("wrong"), false);
  assert.equal(isAdminSecretValid(""), false);
  delete process.env.ADMIN_SECRET;
});

test("admin cookie authorizes; rotating ADMIN_SECRET invalidates it", () => {
  process.env.ADMIN_SECRET = "secret-one";
  const res = fakeResCapture();
  setAdminCookie(res);
  const cookie = cookieHeaderFrom(res.cookies[0]);
  assert.equal(isValidAdminRequest({ headers: { cookie }, query: {} }), true);
  // Rotate the secret — the old cookie's fingerprint no longer matches.
  process.env.ADMIN_SECRET = "secret-two";
  assert.equal(isValidAdminRequest({ headers: { cookie }, query: {} }), false);
  delete process.env.ADMIN_SECRET;
});

test("isValidTestRequest: X-Test-Secret or X-Admin-Secret header only", () => {
  delete process.env.ADMIN_SECRET;
  process.env.TEST_ALERT_SECRET = "test-tok";
  assert.equal(isValidTestRequest({ headers: { "x-test-secret": "test-tok" }, query: {} }), true);
  assert.equal(isValidTestRequest({ headers: {}, query: { secret: "test-tok" } }), false);
  assert.equal(isValidTestRequest({ headers: { "x-test-secret": "nope" }, query: {} }), false);
  process.env.ADMIN_SECRET = "admin-tok";
  assert.equal(isValidTestRequest({ headers: { "x-admin-secret": "admin-tok" }, query: {} }), true);
  delete process.env.TEST_ALERT_SECRET;
  delete process.env.ADMIN_SECRET;
});

test("canAccessAccount: requires session match OR admin", () => {
  delete process.env.ADMIN_SECRET;
  // No session, no admin -> denied
  assert.equal(canAccessAccount({ headers: {}, query: {} }, "acct"), false);

  // Session for a different account -> denied
  const res = fakeRes();
  setSessionCookie(res, "acct-A");
  const req = reqWithCookie(`replyr_session=${encodeURIComponent(getSetCookieValue(res))}`);
  req.query = {};
  assert.equal(canAccessAccount(req, "acct-B"), false);

  // Session matches -> allowed
  assert.equal(canAccessAccount(req, "acct-A"), true);

  // Admin -> allowed even for any accountId
  process.env.ADMIN_SECRET = "shhh";
  const adminReq = { headers: { "x-admin-secret": "shhh" }, query: {} };
  assert.equal(canAccessAccount(adminReq, "any"), true);
  delete process.env.ADMIN_SECRET;
});

test("canAccessAccount: missing accountId is denied", () => {
  assert.equal(canAccessAccount({ headers: {}, query: {} }, ""), false);
  assert.equal(canAccessAccount({ headers: {}, query: {} }, null), false);
});
