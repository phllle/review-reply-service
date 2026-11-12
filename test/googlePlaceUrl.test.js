import { test } from "node:test";
import assert from "node:assert/strict";
import { googlePlaceUrl } from "../src/firstReply.js";
import { buildSignupEmail } from "../src/signupNotify.js";

test("googlePlaceUrl: Maps URL API format with name query + query_place_id", () => {
  const url = googlePlaceUrl("ChIJ123abc", "Castle Nail Bar & Spa");
  assert.equal(
    url,
    "https://www.google.com/maps/search/?api=1&query=Castle%20Nail%20Bar%20%26%20Spa&query_place_id=ChIJ123abc"
  );
  assert.ok(url.includes("query_place_id="));
  assert.ok(!url.includes("maps/place/?q=place_id"));
});

test("googlePlaceUrl: fallbacks — name-only, id-only, null when both missing", () => {
  assert.equal(
    googlePlaceUrl(null, "Northstar Dental"),
    "https://www.google.com/maps/search/?api=1&query=Northstar%20Dental"
  );
  assert.equal(
    googlePlaceUrl("ChIJ123abc", null),
    "https://www.google.com/maps/search/?api=1&query_place_id=ChIJ123abc"
  );
  assert.equal(googlePlaceUrl(null, null), null);
  assert.equal(googlePlaceUrl("", "  "), null);
});

test("buildSignupEmail: Google link uses the Maps URL API format, not the broken place search", () => {
  const { text } = buildSignupEmail({
    name: "Castle Nail Bar",
    accountId: "acct-1",
    locationId: "loc-1",
    placeId: "ChIJ123abc",
    trialEndsAt: "2026-12-11T00:00:00Z"
  });
  assert.ok(text.includes("query_place_id=ChIJ123abc"));
  assert.ok(text.includes("query=Castle%20Nail%20Bar"));
  assert.ok(!text.includes("maps/place/?q=place_id"));
});
