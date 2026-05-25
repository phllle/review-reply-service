import { test } from "node:test";
import assert from "node:assert/strict";

process.env.REPLYR_SESSION_SECRET = "test-subscribe-session-secret-1234567";
delete process.env.NODE_ENV;

const { setSessionCookie, readSessionAccountId } = await import("../src/sessionAuth.js");

function fakeRes() {
  const headers = {};
  return {
    headers,
    append(key, value) {
      headers[key] = headers[key] ? [].concat(headers[key], value) : value;
    }
  };
}

function reqWithCookie(cookieHeader) {
  return { headers: { cookie: cookieHeader || "" } };
}

function cookieFor(accountId) {
  const res = fakeRes();
  setSessionCookie(res, accountId);
  // setSessionCookie writes "<NAME>=<token>; Path=/; HttpOnly; ..."; for a request
  // we only need the "<NAME>=<token>" part.
  const raw = Array.isArray(res.headers["Set-Cookie"]) ? res.headers["Set-Cookie"][0] : res.headers["Set-Cookie"];
  return raw.split(";")[0];
}

test("session cookie round-trip: setSessionCookie value reads back as same accountId", () => {
  const accountId = "acct-subscribe-session-123";
  const cookie = cookieFor(accountId);
  const got = readSessionAccountId(reqWithCookie(cookie));
  assert.equal(got, accountId);
});

test("readSessionAccountId returns null when cookie is absent", () => {
  assert.equal(readSessionAccountId(reqWithCookie("")), null);
});

test("readSessionAccountId returns null when cookie is for a different secret", async () => {
  const accountId = "acct-x";
  const cookie = cookieFor(accountId);
  // Re-import the module under a fresh secret — same cookie should now fail HMAC.
  const otherSecret = "different-secret-zzzzzzzzzzzzz";
  process.env.REPLYR_SESSION_SECRET = otherSecret;
  // The current module instance has the old secret cached via getSessionSecret(),
  // which reads process.env.REPLYR_SESSION_SECRET on every call — so this works.
  try {
    const got = readSessionAccountId(reqWithCookie(cookie));
    assert.equal(got, null);
  } finally {
    process.env.REPLYR_SESSION_SECRET = "test-subscribe-session-secret-1234567";
  }
});
