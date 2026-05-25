import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEmailFromTokenResponse } from "../src/googleEmail.js";

function makeJwt(payload) {
  // We don't sign — extractEmailFromTokenResponse trusts the payload layer
  // since it came via TLS from Google's token endpoint.
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.signature-placeholder`;
}

test("extractEmailFromTokenResponse: returns verified email", () => {
  const tokens = {
    id_token: makeJwt({ email: "owner@example.com", email_verified: true })
  };
  assert.equal(extractEmailFromTokenResponse(tokens), "owner@example.com");
});

test("extractEmailFromTokenResponse: lowercases and trims", () => {
  const tokens = {
    id_token: makeJwt({ email: "  Owner@Example.COM  ", email_verified: true })
  };
  assert.equal(extractEmailFromTokenResponse(tokens), "owner@example.com");
});

test("extractEmailFromTokenResponse: defaults to accepting when email_verified missing", () => {
  // Google's id_token usually has email_verified=true, but if it's omitted
  // (e.g. older flows), we accept rather than block — strictly false is what
  // we reject.
  const tokens = {
    id_token: makeJwt({ email: "owner@example.com" })
  };
  assert.equal(extractEmailFromTokenResponse(tokens), "owner@example.com");
});

test("extractEmailFromTokenResponse: rejects email_verified=false", () => {
  const tokens = {
    id_token: makeJwt({ email: "owner@example.com", email_verified: false })
  };
  assert.equal(extractEmailFromTokenResponse(tokens), null);
});

test("extractEmailFromTokenResponse: rejects malformed id_token", () => {
  assert.equal(extractEmailFromTokenResponse({ id_token: "not.a.jwt.really" }), null);
  assert.equal(extractEmailFromTokenResponse({ id_token: "no-dots" }), null);
  assert.equal(extractEmailFromTokenResponse({ id_token: "a.b" }), null);
});

test("extractEmailFromTokenResponse: returns null when id_token is missing", () => {
  assert.equal(extractEmailFromTokenResponse({}), null);
  assert.equal(extractEmailFromTokenResponse({ access_token: "x" }), null);
  assert.equal(extractEmailFromTokenResponse(null), null);
  assert.equal(extractEmailFromTokenResponse(undefined), null);
});

test("extractEmailFromTokenResponse: rejects payload with non-string email", () => {
  const tokens = { id_token: makeJwt({ email: 12345, email_verified: true }) };
  assert.equal(extractEmailFromTokenResponse(tokens), null);
});

test("extractEmailFromTokenResponse: rejects garbage email format", () => {
  const tokens = { id_token: makeJwt({ email: "not-an-email", email_verified: true }) };
  assert.equal(extractEmailFromTokenResponse(tokens), null);
});

test("extractEmailFromTokenResponse: handles base64url payload (with - / _ chars)", () => {
  // Construct a payload whose JSON encodes to bytes containing '+' or '/' in
  // standard base64 — base64url uses '-' and '_' instead.
  const payload = {
    email: "owner@example.com",
    email_verified: true,
    extra: ">>?>>" // forces base64 chars we'd lose without base64url
  };
  const tokens = { id_token: makeJwt(payload) };
  assert.equal(extractEmailFromTokenResponse(tokens), "owner@example.com");
});
