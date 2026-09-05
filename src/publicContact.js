/** Public customer-facing support address. Ops alerts stay on ALERT_EMAIL. */
export const PUBLIC_CONTACT_EMAIL = "hello@replyr.pro";

export function publicContactEmail() {
  const raw = String(process.env.REPLYR_CONTACT || PUBLIC_CONTACT_EMAIL).trim();
  if (!raw) return PUBLIC_CONTACT_EMAIL;
  if (/^https?:\/\//i.test(raw)) return PUBLIC_CONTACT_EMAIL;
  return raw.replace(/^mailto:/i, "").trim() || PUBLIC_CONTACT_EMAIL;
}

export function publicContactMailtoHref() {
  return "mailto:" + publicContactEmail();
}
