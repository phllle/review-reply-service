import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewCardData, buildReviewCardHtml } from "../src/reviewCard.js";

test("buildReviewCardData: place_id → direct writereview link + short displayUrl", () => {
  const data = buildReviewCardData({ name: "Castle Nail Bar", placeId: "ChIJ123abc" });
  assert.equal(data.businessName, "Castle Nail Bar");
  assert.equal(data.reviewUrl, "https://search.google.com/local/writereview?placeid=ChIJ123abc");
  assert.equal(data.displayUrl, "search.google.com/local/writereview");
});

test("buildReviewCardData: no place_id → Maps name search + search-hint displayUrl", () => {
  const data = buildReviewCardData({ name: "Northstar Dental", placeId: null });
  assert.equal(data.reviewUrl, "https://www.google.com/maps/search/?api=1&query=Northstar%20Dental");
  assert.equal(data.displayUrl, "google.com/maps — search “Northstar Dental”");
});

test("buildReviewCardData: missing business/name falls back sanely", () => {
  const data = buildReviewCardData(null);
  assert.equal(data.businessName, "our business");
  assert.ok(data.reviewUrl.includes("api=1"));
});

test("buildReviewCardHtml: card rendered twice (2-up), name escaped, print button present", () => {
  const html = buildReviewCardHtml({
    businessName: "Bob's <Cuts> & Co",
    displayUrl: "search.google.com/local/writereview",
    qrSvg: "<svg viewBox=\"0 0 10 10\"></svg>"
  });
  assert.equal(html.match(/class="rc-card"/g).length, 2);
  assert.ok(html.includes("Bob&#39;s") || html.includes("Bob's"));
  assert.ok(!html.includes("<Cuts>"));
  assert.ok(html.includes("Enjoyed your visit?"));
  assert.ok(html.includes("Scan to leave us a Google review"));
});

test("buildReviewCardHtml: print wired via external script (CSP blocks inline handlers), Replyr branding on the card", () => {
  const html = buildReviewCardHtml({
    businessName: "Castle Nail Bar",
    displayUrl: "search.google.com/local/writereview",
    qrSvg: "<svg viewBox=\"0 0 10 10\"></svg>"
  });
  // Inline event handlers are blocked by the site's CSP — the button must
  // have an id and be wired from the external /review-card.js instead.
  assert.ok(!html.includes("onclick"));
  assert.ok(html.includes('id="rcPrintBtn"'));
  assert.ok(html.includes('<script src="/review-card.js" defer></script>'));
  // Branding appears once per printed card (2-up).
  assert.equal(html.match(/Powered by/g).length, 2);
  assert.ok(html.includes("replyr.pro"));
});
