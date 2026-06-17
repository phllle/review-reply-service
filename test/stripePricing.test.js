import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProPriceIds,
  subscriptionHasProPrice,
  getProTierFromSubscription,
  getProTierFromCheckoutMetadata,
  subscribedAtForSubscriptionStatus,
  subscriptionStatusKeepsAccess
} from "../src/stripePricing.js";

const env = {
  STRIPE_PRO_PRICE_ID: "price_legacy",
  STRIPE_PRO_STARTER_PRICE_ID: "price_starter",
  STRIPE_PRO_GROWTH_PRICE_ID: "price_growth",
  STRIPE_PRO_SCALE_PRICE_ID: "price_scale"
};
const priceIds = getProPriceIds(env);

function sub(...itemIds) {
  return { items: { data: itemIds.map((id) => ({ price: { id } })) } };
}

test("getProPriceIds trims and lists only configured ids", () => {
  const partial = getProPriceIds({
    STRIPE_PRO_STARTER_PRICE_ID: "  price_starter  ",
    STRIPE_PRO_GROWTH_PRICE_ID: ""
  });
  assert.equal(partial.starter, "price_starter");
  assert.deepEqual(partial.all, ["price_starter"]);
});

test("subscriptionHasProPrice: true when any item matches", () => {
  assert.equal(subscriptionHasProPrice(sub("price_starter"), priceIds), true);
  assert.equal(subscriptionHasProPrice(sub("price_other", "price_growth"), priceIds), true);
});

test("subscriptionHasProPrice: false for unrelated price", () => {
  assert.equal(subscriptionHasProPrice(sub("price_unknown"), priceIds), false);
});

test("subscriptionHasProPrice: false for malformed subscription", () => {
  assert.equal(subscriptionHasProPrice(null, priceIds), false);
  assert.equal(subscriptionHasProPrice({}, priceIds), false);
  assert.equal(subscriptionHasProPrice({ items: {} }, priceIds), false);
});

test("subscriptionHasProPrice: false when no Pro prices configured", () => {
  const empty = getProPriceIds({});
  assert.equal(subscriptionHasProPrice(sub("price_starter"), empty), false);
});

test("getProTierFromSubscription: highest tier wins (scale > growth > starter)", () => {
  assert.equal(
    getProTierFromSubscription(sub("price_starter", "price_scale", "price_growth"), priceIds),
    "scale"
  );
  assert.equal(
    getProTierFromSubscription(sub("price_starter", "price_growth"), priceIds),
    "growth"
  );
  assert.equal(getProTierFromSubscription(sub("price_starter"), priceIds), "starter");
});

test("getProTierFromSubscription: legacy pro price maps to starter tier", () => {
  assert.equal(getProTierFromSubscription(sub("price_legacy"), priceIds), "starter");
});

test("getProTierFromSubscription: unknown subscription falls back to starter", () => {
  assert.equal(getProTierFromSubscription(sub("price_other"), priceIds), "starter");
  assert.equal(getProTierFromSubscription(null, priceIds), "starter");
});

test("getProTierFromSubscription: handles items.data with bare price string", () => {
  const subBare = { items: { data: [{ price: "price_growth" }] } };
  assert.equal(getProTierFromSubscription(subBare, priceIds), "growth");
});

test("subscriptionStatusKeepsAccess: keeps access during active/trialing/dunning only", () => {
  assert.equal(subscriptionStatusKeepsAccess("active"), true);
  assert.equal(subscriptionStatusKeepsAccess("trialing"), true);
  assert.equal(subscriptionStatusKeepsAccess("past_due"), true);
  assert.equal(subscriptionStatusKeepsAccess("canceled"), false);
  assert.equal(subscriptionStatusKeepsAccess("incomplete_expired"), false);
  assert.equal(subscriptionStatusKeepsAccess("unpaid"), false);
});

test("subscribedAtForSubscriptionStatus: preserves existing timestamp while access remains", () => {
  const existing = "2026-05-01T00:00:00.000Z";
  const now = new Date("2026-05-26T12:00:00.000Z");
  assert.equal(subscribedAtForSubscriptionStatus("past_due", existing, now), existing);
  assert.equal(subscribedAtForSubscriptionStatus("active", "", now), "2026-05-26T12:00:00.000Z");
  assert.equal(subscribedAtForSubscriptionStatus("canceled", existing, now), null);
});

test("getProTierFromCheckoutMetadata: accepts app checkout Pro metadata", () => {
  assert.equal(getProTierFromCheckoutMetadata({ pro_tier: "growth" }), "growth");
  assert.equal(getProTierFromCheckoutMetadata({ proTier: "scale" }), "scale");
  assert.equal(getProTierFromCheckoutMetadata({ pro_tier: "pro" }), "starter");
  assert.equal(getProTierFromCheckoutMetadata({ pro_tier: "unknown" }), null);
  assert.equal(getProTierFromCheckoutMetadata(null), null);
});
