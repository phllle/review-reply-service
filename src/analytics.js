/**
 * Google tag (gtag.js) + Consent Mode v2 for the marketing site (kit §7
 * step 1, §12 step 4).
 *
 * Driven entirely by GA_MEASUREMENT_ID: when the env var is unset (local
 * dev, tests) nothing renders at all — no tag, no consent defaults, no
 * client script. When set, every marketing page gets:
 *   1. Consent Mode v2 defaults (all storage denied until the visitor
 *      accepts in the banner rendered by public/analytics.js),
 *   2. the async gtag.js loader + config,
 *   3. public/analytics.js (attribution capture, consent banner,
 *      connect_click + OAuth pre-frame).
 *
 * The measurement ID is format-validated before interpolation so a
 * misconfigured env var can never break out of the script context.
 */

const GA_ID_PATTERN = /^G-[A-Z0-9]{4,}$/i;

/** The configured GA4 measurement ID, or null when unset/invalid. */
export function getGaMeasurementId(env = process.env) {
  const raw = (env.GA_MEASUREMENT_ID || "").trim();
  return GA_ID_PATTERN.test(raw) ? raw : null;
}

export function isGaTagEnabled(env = process.env) {
  return getGaMeasurementId(env) !== null;
}

/**
 * The <head> snippet for marketing pages. Returns "" when GA is not
 * configured. Safe to interpolate into HTML (the ID is pattern-checked).
 */
export function googleTagHeadHtml(env = process.env) {
  const id = getGaMeasurementId(env);
  if (!id) return "";
  return `<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'denied',
  analytics_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  wait_for_update: 500
});
window.REPLYR_GA_ID = '${id}';
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
gtag('js', new Date());
gtag('config', '${id}');
</script>
<script src="/analytics.js" defer></script>`;
}
