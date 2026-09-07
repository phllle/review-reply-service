import { test } from "node:test";
import assert from "node:assert/strict";

// No DATABASE_URL -> in-memory state path.
delete process.env.DATABASE_URL;

const { isOAuthStateExpired, generateState, validateState } = await import("../src/google.js");

const TTL = 10 * 60 * 1000;

test("isOAuthStateExpired: fresh, expired, missing", () => {
  const now = 1_000_000_000;
  assert.equal(isOAuthStateExpired(now, now), false);
  assert.equal(isOAuthStateExpired(now - (TTL - 1), now), false);
  assert.equal(isOAuthStateExpired(now - (TTL + 1), now), true);
  assert.equal(isOAuthStateExpired(null, now), true);
  assert.equal(isOAuthStateExpired(undefined, now), true);
});

test("validateState: unknown state is rejected", async () => {
  const r = await validateState("never-issued");
  assert.equal(r.ok, false);
});

test("validateState: empty state is rejected", async () => {
  assert.equal((await validateState("")).ok, false);
  assert.equal((await validateState(null)).ok, false);
});

test("generate -> validate is one-time and returns returnTo", async () => {
  const state = await generateState("/connected?accountId=1");
  const first = await validateState(state);
  assert.equal(first.ok, true);
  assert.equal(first.returnTo, "/connected?accountId=1");
  // Consumed — second use fails.
  const second = await validateState(state);
  assert.equal(second.ok, false);
});

test("generate with no returnTo stores null", async () => {
  const state = await generateState();
  const r = await validateState(state);
  assert.equal(r.ok, true);
  assert.equal(r.returnTo, null);
});
