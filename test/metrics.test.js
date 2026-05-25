import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPlanAmountsCents,
  classifyBusinessPlan,
  computeMrr,
  computeFunnel,
  formatCentsAsUsd
} from "../src/metrics.js";

const env = {
  STRIPE_BASE_PRICE_AMOUNT_CENTS: "1900",
  STRIPE_PRO_STARTER_AMOUNT_CENTS: "3900",
  STRIPE_PRO_GROWTH_AMOUNT_CENTS: "6900",
  STRIPE_PRO_SCALE_AMOUNT_CENTS: "14900"
};
const amounts = getPlanAmountsCents(env);

test("getPlanAmountsCents: parses positive ints; bad input -> 0", () => {
  assert.equal(amounts.base, 1900);
  assert.equal(amounts.proStarter, 3900);
  assert.equal(amounts.proGrowth, 6900);
  assert.equal(amounts.proScale, 14900);
  const bad = getPlanAmountsCents({
    STRIPE_BASE_PRICE_AMOUNT_CENTS: "not-a-number",
    STRIPE_PRO_STARTER_AMOUNT_CENTS: "-50"
  });
  assert.equal(bad.base, 0);
  assert.equal(bad.proStarter, 0);
});

test("classifyBusinessPlan: handles all combinations", () => {
  assert.equal(classifyBusinessPlan(null), "none");
  assert.equal(classifyBusinessPlan({}), "none");
  // Subscribed but not Pro = base
  assert.equal(
    classifyBusinessPlan({ subscribedAt: "2026-01-01T00:00:00Z", isPro: false }),
    "base"
  );
  // Pro tiers
  assert.equal(classifyBusinessPlan({ isPro: true, proTier: "starter" }), "pro_starter");
  assert.equal(classifyBusinessPlan({ isPro: true, proTier: "growth" }), "pro_growth");
  assert.equal(classifyBusinessPlan({ isPro: true, proTier: "scale" }), "pro_scale");
  // Pro with weird tier -> starter (safe default from normalizeProTier)
  assert.equal(classifyBusinessPlan({ isPro: true, proTier: "??" }), "pro_starter");
  // Trial-only (no subscription, not Pro) = none
  assert.equal(classifyBusinessPlan({ trialEndsAt: "2026-12-31T00:00:00Z" }), "none");
});

test("computeMrr: sums per-plan amounts and counts", () => {
  const businesses = [
    { accountId: "1", subscribedAt: "2026-01-01", isPro: false }, // base $19
    { accountId: "2", isPro: true, proTier: "starter" },           // $39
    { accountId: "3", isPro: true, proTier: "growth" },            // $69
    { accountId: "4", isPro: true, proTier: "scale" },             // $149
    { accountId: "5" }                                              // none
  ];
  const m = computeMrr(businesses, amounts);
  assert.equal(m.mrrCents, 1900 + 3900 + 6900 + 14900);
  assert.deepEqual(m.countsByPlan, {
    base: 1,
    pro_starter: 1,
    pro_growth: 1,
    pro_scale: 1,
    pro_legacy: 0,
    none: 1
  });
  assert.equal(m.mrrByPlan.base, 1900);
  assert.equal(m.mrrByPlan.pro_growth, 6900);
  assert.equal(m.activeSubs, 4);
});

test("computeMrr: empty / null input is safe", () => {
  const m = computeMrr([], amounts);
  assert.equal(m.mrrCents, 0);
  assert.equal(m.activeSubs, 0);
  const m2 = computeMrr(null, amounts);
  assert.equal(m2.mrrCents, 0);
});

test("computeMrr: missing env amount -> 0 contribution (counts still increment)", () => {
  const noScale = getPlanAmountsCents({
    STRIPE_BASE_PRICE_AMOUNT_CENTS: "1900",
    STRIPE_PRO_STARTER_AMOUNT_CENTS: "3900",
    STRIPE_PRO_GROWTH_AMOUNT_CENTS: "6900"
    // no scale
  });
  const businesses = [
    { accountId: "1", isPro: true, proTier: "scale" }
  ];
  const m = computeMrr(businesses, noScale);
  assert.equal(m.mrrCents, 0);
  assert.equal(m.countsByPlan.pro_scale, 1);
});

function trialBusiness({ accountId, daysAgoStarted, subscribedAfterDays = null, isPro = false }) {
  const now = new Date("2026-05-25T00:00:00Z");
  const trialStart = new Date(now.getTime() - daysAgoStarted * 24 * 60 * 60 * 1000);
  const trialEndsAt = new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000);
  const subscribedAt =
    subscribedAfterDays != null
      ? new Date(trialStart.getTime() + subscribedAfterDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
  return {
    accountId,
    trialEndsAt: trialEndsAt.toISOString(),
    subscribedAt,
    isPro
  };
}

test("computeFunnel: trials started + trial->paid in window", () => {
  const now = new Date("2026-05-25T00:00:00Z");
  const businesses = [
    trialBusiness({ accountId: "in-window-paid", daysAgoStarted: 5, subscribedAfterDays: 7 }),
    trialBusiness({ accountId: "in-window-paid-2", daysAgoStarted: 14, subscribedAfterDays: 20 }),
    trialBusiness({ accountId: "in-window-no-sub", daysAgoStarted: 10, subscribedAfterDays: null }),
    trialBusiness({ accountId: "out-of-window", daysAgoStarted: 60, subscribedAfterDays: 5 })
  ];
  const f = computeFunnel(businesses, { windowDays: 30, now });
  assert.equal(f.trialsStarted, 3);
  assert.equal(f.trialToPaid, 2);
  assert.equal(f.conversionRate, 2 / 3);
  assert.equal(f.totalConnected, 4);
});

test("computeFunnel: active trial + trial-ended-no-sub buckets", () => {
  const now = new Date("2026-05-25T00:00:00Z");
  const businesses = [
    // Trial started 5 days ago (still active)
    trialBusiness({ accountId: "active-trial", daysAgoStarted: 5 }),
    // Trial ended 10 days ago, no subscription
    trialBusiness({ accountId: "ended-no-sub", daysAgoStarted: 40 }),
    // Trial ended but is Pro now
    trialBusiness({ accountId: "ended-but-pro", daysAgoStarted: 40, isPro: true }),
    // Gratis account, trial ended, no sub
    trialBusiness({ accountId: "gratis", daysAgoStarted: 40 })
  ];
  const f = computeFunnel(businesses, {
    now,
    isGratis: (id) => id === "gratis"
  });
  assert.equal(f.activeTrial, 1);
  // ended-no-sub: 1 (the others are excluded: pro, gratis)
  assert.equal(f.trialEndedNoSub, 1);
});

test("computeFunnel: empty / no trial dates is safe", () => {
  const f = computeFunnel([], {});
  assert.equal(f.trialsStarted, 0);
  assert.equal(f.conversionRate, 0);
  assert.equal(f.totalConnected, 0);
  const f2 = computeFunnel([{ accountId: "x" }], { now: new Date() });
  assert.equal(f2.totalConnected, 1);
  assert.equal(f2.trialsStarted, 0);
});

test("formatCentsAsUsd: standard formatting", () => {
  assert.equal(formatCentsAsUsd(0), "$0.00");
  assert.equal(formatCentsAsUsd(1900), "$19.00");
  assert.equal(formatCentsAsUsd(149999), "$1,499.99");
  assert.equal(formatCentsAsUsd(-50), "$0.00"); // floor at 0
  assert.equal(formatCentsAsUsd("not-a-number"), "$0.00");
});
