export const PRO_SMS_TIERS = {
  starter: { includedSms: 500 },
  growth: { includedSms: 2500 },
  scale: { includedSms: 10000 }
};

export function normalizeProTier(value) {
  const tier = String(value || "starter").trim().toLowerCase();
  return PRO_SMS_TIERS[tier] ? tier : "starter";
}

export function getIncludedSmsForTier(tier) {
  const t = normalizeProTier(tier);
  return PRO_SMS_TIERS[t].includedSms;
}

export function getCurrentMonthKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
