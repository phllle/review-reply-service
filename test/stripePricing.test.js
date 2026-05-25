import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProPriceIds,
  subscriptionHasProPrice,
  getProTierFromSubscription
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
