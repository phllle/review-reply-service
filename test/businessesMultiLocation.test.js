import { test } from "node:test";
import assert from "node:assert/strict";
import {
  businessKey,
  mergeBusinessUpsert,
  selectEnabledBusinesses,
  isTrialActive
} from "../src/businesses.js";

// Simulate the in-memory / file-store map that readBusinesses returns. Each
// upsert applies mergeBusinessUpsert and writes back at the composite key,
// mirroring src/businesses.js upsertBusiness.
function applyUpsert(map, config) {
  const merged = mergeBusinessUpsert(map, config, { now: "2026-01-01T00:00:00.000Z" });
  return { ...map, [businessKey(config.accountId, config.locationId)]: merged };
}

test("two locations under the same accountId both persist", () => {
  let map = {};
  map = applyUpsert(map, { accountId: "acct1", locationId: "locA", name: "Loc A" });
  map = applyUpsert(map, { accountId: "acct1", locationId: "locB", name: "Loc B" });
  const keys = Object.keys(map);
  assert.equal(keys.length, 2);
  assert.ok(map["acct1::locA"]);
  assert.ok(map["acct1::locB"]);
  assert.equal(map["acct1::locA"].name, "Loc A");
  assert.equal(map["acct1::locB"].name, "Loc B");
});

test("upserting location A does not clobber location B", () => {
  let map = {};
  map = applyUpsert(map, { accountId: "acct1", locationId: "locA", name: "A", contact: "call A" });
  map = applyUpsert(map, { accountId: "acct1", locationId: "locB", name: "B", contact: "call B" });
  // Update A only.
  map = applyUpsert(map, { accountId: "acct1", locationId: "locA", contact: "call A updated" });
  assert.equal(map["acct1::locA"].contact, "call A updated");
  assert.equal(map["acct1::locA"].name, "A"); // preserved
  // B untouched.
  assert.equal(map["acct1::locB"].name, "B");
  assert.equal(map["acct1::locB"].contact, "call B");
});

test("getEnabledBusinesses returns both locations when independently enabled", () => {
  let map = {};
  // Both on active trial (no trialEndsAt => active) and independently enabled.
  map = applyUpsert(map, { accountId: "acct1", locationId: "locA", autoReplyEnabled: true });
  map = applyUpsert(map, { accountId: "acct1", locationId: "locB", autoReplyEnabled: true });
  const enabled = selectEnabledBusinesses(map, { isGratis: () => false });
  const locs = enabled.map((b) => b.locationId).sort();
  assert.deepEqual(locs, ["locA", "locB"]);
});

test("only the enabled location is returned when the other is disabled", () => {
  let map = {};
  map = applyUpsert(map, { accountId: "acct1", locationId: "locA", autoReplyEnabled: true });
  map = applyUpsert(map, { accountId: "acct1", locationId: "locB", autoReplyEnabled: false });
  const enabled = selectEnabledBusinesses(map, { isGratis: () => false });
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].locationId, "locA");
});

test("a new sibling location inherits account-level billing (Pro/subscription/customer)", () => {
  let map = {};
  // First location subscribes to Pro.
  map = applyUpsert(map, { accountId: "acct1", locationId: "locA" });
  map = applyUpsert(map, {
    accountId: "acct1",
    locationId: "locA",
    subscribedAt: "2026-01-01T00:00:00.000Z",
    isPro: true,
    proTier: "growth",
    stripeCustomerId: "cus_123"
  });
  // Owner adds a second location — billing should carry over so the webhook
  // (which updates the primary row) keeps every location consistent.
  map = applyUpsert(map, { accountId: "acct1", locationId: "locB", name: "B" });
  const b = map["acct1::locB"];
  assert.equal(b.isPro, true);
  assert.equal(b.proTier, "growth");
  assert.equal(b.subscribedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(b.stripeCustomerId, "cus_123");
});

test("a brand-new account's first location starts a trial; per-location fields stay independent", () => {
  let map = {};
  map = applyUpsert(map, { accountId: "acct1", locationId: "locA" });
  assert.ok(map["acct1::locA"].trialEndsAt, "first location gets a trial end date");
  // A different account is fully independent.
  map = applyUpsert(map, { accountId: "acct2", locationId: "locZ", contact: "call Z" });
  assert.equal(map["acct2::locZ"].contact, "call Z");
  assert.equal(Object.keys(map).length, 2);
});

test("isTrialActive: future date active, past date inactive, missing date active", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  assert.equal(isTrialActive({ trialEndsAt: "2026-07-01T00:00:00.000Z" }, now), true);
  assert.equal(isTrialActive({ trialEndsAt: "2026-05-01T00:00:00.000Z" }, now), false);
  assert.equal(isTrialActive({ trialEndsAt: null }, now), true);
});
