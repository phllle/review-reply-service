/**
 * Pure helpers for mapping a Stripe subscription/price IDs to Replyr's
 * plan flags (`isPro`, `proTier`). No Stripe SDK calls — these are exercised
 * by the Stripe webhook handler and are the hottest correctness path in the
 * billing flow.
 */

/**
 * @param {object} env - Stripe price IDs (defaults to process.env when undefined keys)
 * @returns {{ legacyPro: string, starter: string, growth: string, scale: string, all: string[] }}
 */
export function getProPriceIds(env = process.env) {
  const legacyPro = (env.STRIPE_PRO_PRICE_ID || "").trim();
  const starter = (env.STRIPE_PRO_STARTER_PRICE_ID || "").trim();
  const growth = (env.STRIPE_PRO_GROWTH_PRICE_ID || "").trim();
  const scale = (env.STRIPE_PRO_SCALE_PRICE_ID || "").trim();
  const all = [legacyPro, starter, growth, scale].filter(Boolean);
  return { legacyPro, starter, growth, scale, all };
}

function priceIdOf(item) {
  return item?.price?.id || item?.price || "";
}

/**
 * @param {object} subscription - Stripe subscription object (`items.data` shape)
 * @param {ReturnType<getProPriceIds>} priceIds
 */
export function subscriptionHasProPrice(subscription, priceIds) {
  if (!priceIds?.all?.length) return false;
  const items = subscription?.items?.data;
  if (!Array.isArray(items)) return false;
  return items.some((item) => priceIds.all.includes(priceIdOf(item)));
}

/**
 * Pick the highest matching tier in this subscription. Falls back to "starter"
 * when the legacy pro price is the match (no tier breakdown) or no tier matches.
 * @returns {"starter"|"growth"|"scale"}
 */
export function getProTierFromSubscription(subscription, priceIds) {
  const ids = (subscription?.items?.data || []).map(priceIdOf).filter(Boolean);
  if (priceIds.scale && ids.includes(priceIds.scale)) return "scale";
  if (priceIds.growth && ids.includes(priceIds.growth)) return "growth";
  if (priceIds.starter && ids.includes(priceIds.starter)) return "starter";
  if (priceIds.legacyPro && ids.includes(priceIds.legacyPro)) return "starter";
  return "starter";
}
