import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeAttribution,
  parseAttributionCookieValue,
  readCookieValue,
  attributionFromRequest
} from "../src/attribution.js";

test("sanitizeAttribution: maps cookie keys to business fields", () => {
  const out = sanitizeAttribution({
    gclid: "abc123",
    ga_client_id: "111.222",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "core-us",
    landing_page: "/for/dentists"
  });
  assert.deepEqual(out, {
    gclid: "abc123",
    gaClientId: "111.222",
    utmSource: "google",
    utmMedium: "cpc",
    utmCampaign: "core-us",
    landingPage: "/for/dentists"
  });
});

test("sanitizeAttribution: no IDs present -> null (storage no-op)", () => {
  assert.equal(sanitizeAttribution(null), null);
  assert.equal(sanitizeAttribution(undefined), null);
  assert.equal(sanitizeAttribution({}), null);
  assert.equal(sanitizeAttribution({ gclid: "", utm_source: "   " }), null);
  assert.equal(sanitizeAttribution("not-an-object"), null);
});

test("sanitizeAttribution: unknown keys dropped, values trimmed and capped", () => {
  const out = sanitizeAttribution({ gclid: "  x  ", password: "nope", utm_term: "ignored-here" });
  assert.deepEqual(out, { gclid: "x" });
  const long = sanitizeAttribution({ gclid: "y".repeat(600) });
  assert.equal(long.gclid.length, 512);
});

test("parseAttributionCookieValue: parses JSON cookie, tolerates junk", () => {
  assert.deepEqual(parseAttributionCookieValue(JSON.stringify({ gclid: "g1" })), { gclid: "g1" });
  assert.equal(parseAttributionCookieValue(encodeURIComponent(JSON.stringify({ gclid: "g2" }))).gclid, "g2");
  assert.equal(parseAttributionCookieValue("not json"), null);
  assert.equal(parseAttributionCookieValue(""), null);
  assert.equal(parseAttributionCookieValue(null), null);
});

test("readCookieValue: finds one cookie among several", () => {
  assert.equal(readCookieValue("a=1; replyr_attr=xyz; b=2", "replyr_attr"), "xyz");
  assert.equal(readCookieValue("a=1", "replyr_attr"), null);
  assert.equal(readCookieValue(undefined, "replyr_attr"), null);
});

test("attributionFromRequest: reads the replyr_attr cookie end to end", () => {
  const req = {
    headers: {
      cookie: `session=x; replyr_attr=${encodeURIComponent(JSON.stringify({ gclid: "g9", utm_source: "google" }))}`
    }
  };
  assert.deepEqual(attributionFromRequest(req), { gclid: "g9", utmSource: "google" });
  assert.equal(attributionFromRequest({ headers: {} }), null);
  assert.equal(attributionFromRequest({}), null);
});
