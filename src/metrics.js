/**
 * Pure helpers for the admin MRR + funnel view.
 *
 * MRR is computed locally from the `businesses` table. Each business's plan
 * is mapped to a monthly amount via env vars (cents). Sourcing locally keeps
 * /admin/metrics fast and offline-capable; if the Stripe webhook is wrong,
 * MRR will be wrong — that's intentional, it surfaces drift.
 */

import { normalizeProTier } from "./proPlan.js";

/**
 * Read price->amount (cents) from env. Returns numbers (0 when unset/invalid).
 * Why: matches the way price IDs are configured today (env-driven), no live
 * Stripe API calls.
 */
export function getPlanAmountsCents(env = process.env) {
  return {
    base: parsePositiveInt(env.STRIPE_BASE_PRICE_AMOUNT_CENTS),
    proStarter: parsePositiveInt(env.STRIPE_PRO_STARTER_AMOUNT_CENTS),
    proGrowth: parsePositiveInt(env.STRIPE_PRO_GROWTH_AMOUNT_CENTS),
    proScale: parsePositiveInt(env.STRIPE_PRO_SCALE_AMOUNT_CENTS),
    proLegacy: parsePositiveInt(env.STRIPE_PRO_LEGACY_AMOUNT_CENTS)
  };
}

function parsePositiveInt(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Decide which plan a business is currently on. Pure, derived from business
 * fields the Stripe webhook already maintains.
 *
 * @returns {"base"|"pro_starter"|"pro_growth"|"pro_scale"|"pro_legacy"|"none"}
 */
export function classifyBusinessPlan(business) {
  if (!business) return "none";
  const isPro = !!business.isPro;
  const subscribed = !!business.subscribedAt;
  if (!isPro && !subscribed) return "none";
  if (isPro) {
    const tier = normalizeProTier(business.proTier);
    if (tier === "scale") return "pro_scale";
    if (tier === "growth") return "pro_growth";
    if (tier === "starter") {
      // We can't distinguish "true starter" from legacy single-Pro purely from
      // proTier (the webhook normalizes legacy to 'starter'). Treat the
      // distinction as a billing concern: anyone on tier=starter pays the
      // starter price, with proLegacy reserved as an env override if you want
      // grandfathered customers priced separately.
      return "pro_starter";
    }
    return "pro_starter";
  }
  // Subscribed but not Pro = base Replyr plan.
  return "base";
}

const PLAN_TO_AMOUNT_KEY = {
  base: "base",
  pro_starter: "proStarter",
  pro_growth: "proGrowth",
  pro_scale: "proScale",
  pro_legacy: "proLegacy"
};

/**
 * Compute MRR (cents) and per-plan counts/MRR breakdown.
 * @param {object[]} businesses — array of business objects (already loaded)
 * @param {object} [amounts] — output of getPlanAmountsCents()
 */
export function computeMrr(businesses, amounts = getPlanAmountsCents()) {
  const counts = { base: 0, pro_starter: 0, pro_growth: 0, pro_scale: 0, pro_legacy: 0, none: 0 };
  const mrrByPlan = { base: 0, pro_starter: 0, pro_growth: 0, pro_scale: 0, pro_legacy: 0 };
  let total = 0;
  for (const b of businesses || []) {
    const plan = classifyBusinessPlan(b);
    counts[plan] = (counts[plan] || 0) + 1;
    if (plan === "none") continue;
    const amount = amounts[PLAN_TO_AMOUNT_KEY[plan]] || 0;
    mrrByPlan[plan] = (mrrByPlan[plan] || 0) + amount;
    total += amount;
  }
  return {
    mrrCents: total,
    countsByPlan: counts,
    mrrByPlan,
    activeSubs:
      counts.base + counts.pro_starter + counts.pro_growth + counts.pro_scale + counts.pro_legacy,
    paidSubs: counts.pro_starter + counts.pro_growth + counts.pro_scale + counts.pro_legacy + counts.base
  };
}

/**
 * Compute funnel metrics over a fixed window (default 30 days).
 *
 * Definitions:
 * - Trial start = the trial_ends_at minus 30 days (we hardcode 30-day trials elsewhere).
 * - "Trials started in window" = businesses whose computed trial start is within [now - days, now].
 * - "Trial -> paid in window" = of those, how many also have subscribed_at within [trialStart, trialStart + 30 days].
 * - "Active trial now" = trial_ends_at > now AND no subscription.
 * - "Trial ended without subscribing" = trial_ends_at < now AND no subscription AND not Pro AND not gratis.
 *
 * @param {object[]} businesses
 * @param {object} [opts]
 * @param {number} [opts.windowDays=30]
 * @param {Date} [opts.now=new Date()]
 * @param {function} [opts.isGratis] — (accountId) => boolean
 */
export function computeFunnel(businesses, opts = {}) {
  const windowDays = Math.max(1, Number(opts.windowDays) || 30);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const isGratis = typeof opts.isGratis === "function" ? opts.isGratis : () => false;

  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const TRIAL_LENGTH_DAYS = 30;
  const trialMs = TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000;

  let trialsStarted = 0;
  let trialToPaid = 0;
  let activeTrial = 0;
  let trialEndedNoSub = 0;
  let totalConnected = 0;

  for (const b of businesses || []) {
    if (!b || !b.accountId) continue;
    totalConnected += 1;
    const trialEndsAt = b.trialEndsAt ? new Date(b.trialEndsAt) : null;
    const subscribedAt = b.subscribedAt ? new Date(b.subscribedAt) : null;
    const trialStart = trialEndsAt ? new Date(trialEndsAt.getTime() - trialMs) : null;

    if (trialStart && trialStart >= windowStart && trialStart <= now) {
      trialsStarted += 1;
      if (subscribedAt && subscribedAt >= trialStart && subscribedAt <= new Date(trialStart.getTime() + trialMs)) {
        trialToPaid += 1;
      }
    }

    if (trialEndsAt && trialEndsAt > now && !subscribedAt) {
      activeTrial += 1;
    }
    if (
      trialEndsAt &&
      trialEndsAt < now &&
      !subscribedAt &&
      !b.isPro &&
      !isGratis(b.accountId)
    ) {
      trialEndedNoSub += 1;
    }
  }

  const conversionRate = trialsStarted > 0 ? trialToPaid / trialsStarted : 0;
  return {
    windowDays,
    totalConnected,
    trialsStarted,
    trialToPaid,
    conversionRate,
    activeTrial,
    trialEndedNoSub
  };
}

export function formatCentsAsUsd(cents) {
  const n = Math.max(0, Number(cents) || 0);
  const dollars = n / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
