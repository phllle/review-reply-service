import { test } from "node:test";
import assert from "node:assert/strict";
import { businessKey, mergeBusinessUpsert } from "../src/businesses.js";

// Mirror src/businesses.js upsertBusiness against an in-memory map.
function applyUpsert(map, config, now = "2026-11-05T12:00:00.000Z") {
  const merged = mergeBusinessUpsert(map, config, { now });
  return { ...map, [businessKey(config.accountId, config.locationId)]: merged };
}

test("new account: attribution, preview window and signup time are stored", () => {
  const map = applyUpsert(
    {},
    {
      accountId: "acct1",
      locationId: "locA",
      name: "Shop",
      gclid: "g1",
      gaClientId: "111.222",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "core",
      landingPage: "/for/dentists",
      previewUntil: "2026-11-12T12:00:00.000Z"
    }
  );
  const row = map["acct1::locA"];
  assert.equal(row.gclid, "g1");
  assert.equal(row.gaClientId, "111.222");
  assert.equal(row.utmSource, "google");
  assert.equal(row.utmMedium, "cpc");
  assert.equal(row.utmCampaign, "core");
  assert.equal(row.landingPage, "/for/dentists");
  assert.equal(row.previewUntil, "2026-11-12T12:00:00.000Z");
  assert.equal(row.signupAt, "2026-11-05T12:00:00.000Z");
});

test("attribution is first-touch: a later upsert without IDs keeps the originals", () => {
  let map = applyUpsert({}, { accountId: "a", locationId: "l", gclid: "first", utmSource: "google" });
  map = applyUpsert(map, { accountId: "a", locationId: "l", name: "Renamed" });
  const row = map["a::l"];
  assert.equal(row.gclid, "first");
  assert.equal(row.utmSource, "google");
  assert.equal(row.name, "Renamed");
  // signupAt never moves once set.
  map = applyUpsert(map, { accountId: "a", locationId: "l" }, "2027-01-01T00:00:00.000Z");
  assert.equal(map["a::l"].signupAt, "2026-11-05T12:00:00.000Z");
});

test("preview choice and first-reply claim persist through later upserts", () => {
  let map = applyUpsert({}, { accountId: "a", locationId: "l", previewUntil: "2026-11-12T12:00:00.000Z" });
  map = applyUpsert(map, { accountId: "a", locationId: "l", previewChoice: "off" });
  assert.equal(map["a::l"].previewChoice, "off");
  assert.equal(map["a::l"].previewUntil, "2026-11-12T12:00:00.000Z");
  map = applyUpsert(map, { accountId: "a", locationId: "l", firstReplyAt: "2026-11-06T09:00:00.000Z" });
  assert.equal(map["a::l"].firstReplyAt, "2026-11-06T09:00:00.000Z");
});
