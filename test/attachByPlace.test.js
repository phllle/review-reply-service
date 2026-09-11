import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAttachDecision } from "../src/google.js";

// Build lookups from a fixture of existing businesses keyed by placeId / locationId.
function lookups(existing) {
  const byPlace = new Map(existing.filter((b) => b.placeId).map((b) => [b.placeId, b]));
  const byLoc = new Map(existing.filter((b) => b.locationId).map((b) => [b.locationId, b]));
  return {
    byPlaceId: async (p) => byPlace.get(p) || null,
    byLocationId: async (l) => byLoc.get(l) || null
  };
}

test("existing business with placeId X → attach to the existing accountId", async () => {
  const existing = [{ accountId: "owner-acct", locationId: "loc-owner", placeId: "PLACE_X" }];
  // Second manager gets a different account id but the same location placeId.
  const candidates = [{ accountId: "manager-acct", locationId: "loc-mgr", placeId: "PLACE_X", title: "Castle Nail Bar" }];
  const decision = await resolveAttachDecision(candidates, lookups(existing));
  assert.equal(decision.mode, "attach");
  assert.equal(decision.accountId, "owner-acct"); // session rides the original tenant
});

test("placeId is preferred over locationId when both could match", async () => {
  const existing = [
    { accountId: "by-place", locationId: "other-loc", placeId: "PLACE_X" },
    { accountId: "by-loc", locationId: "loc-mgr", placeId: "PLACE_OTHER" }
  ];
  const candidates = [{ accountId: "manager-acct", locationId: "loc-mgr", placeId: "PLACE_X" }];
  const decision = await resolveAttachDecision(candidates, lookups(existing));
  assert.equal(decision.mode, "attach");
  assert.equal(decision.accountId, "by-place");
});

test("attaches by locationId when placeId is missing", async () => {
  const existing = [{ accountId: "owner-acct", locationId: "loc-shared", placeId: null }];
  const candidates = [{ accountId: "manager-acct", locationId: "loc-shared", placeId: null }];
  const decision = await resolveAttachDecision(candidates, lookups(existing));
  assert.equal(decision.mode, "attach");
  assert.equal(decision.accountId, "owner-acct");
});

test("no matching placeId/locationId → create a new business as today", async () => {
  const existing = [{ accountId: "owner-acct", locationId: "loc-owner", placeId: "PLACE_X" }];
  const candidates = [{ accountId: "new-acct", locationId: "loc-new", placeId: "PLACE_NEW", title: "New Biz" }];
  const decision = await resolveAttachDecision(candidates, lookups(existing));
  assert.equal(decision.mode, "create");
  assert.equal(decision.candidate.accountId, "new-acct");
  assert.equal(decision.candidate.locationId, "loc-new");
});

test("two locations, only one matches → picker attaches only the match", async () => {
  const existing = [{ accountId: "owner-acct", locationId: "loc-owner", placeId: "PLACE_X" }];
  const candidates = [
    { accountId: "manager-acct", locationId: "loc-a", placeId: "PLACE_X", title: "Matches" },
    { accountId: "manager-acct", locationId: "loc-b", placeId: "PLACE_NEW", title: "Brand new" }
  ];
  const decision = await resolveAttachDecision(candidates, lookups(existing));
  assert.equal(decision.mode, "picker");
  const match = decision.options.find((o) => o.locationId === "loc-a");
  const fresh = decision.options.find((o) => o.locationId === "loc-b");
  assert.equal(match.attachTo, "owner-acct"); // attaches to existing tenant
  assert.equal(fresh.attachTo, null); // stays a new business
});

test("multiple locations matching different tenants → picker (ambiguous)", async () => {
  const existing = [
    { accountId: "acct-1", locationId: "l1", placeId: "P1" },
    { accountId: "acct-2", locationId: "l2", placeId: "P2" }
  ];
  const candidates = [
    { accountId: "mgr", locationId: "l1", placeId: "P1" },
    { accountId: "mgr", locationId: "l2", placeId: "P2" }
  ];
  const decision = await resolveAttachDecision(candidates, lookups(existing));
  assert.equal(decision.mode, "picker");
  assert.equal(decision.options.filter((o) => o.attachTo).length, 2);
});

test("no candidates → none", async () => {
  const decision = await resolveAttachDecision([], lookups([]));
  assert.equal(decision.mode, "none");
});
