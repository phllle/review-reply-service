/**
 * Extract the user's email from a Google OAuth token response.
 *
 * Google returns three relevant fields when `openid` + `email` scopes are
 * granted:
 *   - `id_token` — JWT whose payload contains `email` and `email_verified`
 *   - `scope` — space-delimited granted scopes
 *
 * We trust the id_token here without re-verifying signature: it came directly
 * over TLS from Google's token endpoint via the OAuth client, so the
 * signature is not the boundary we need to defend against.
 *
 * Returns null when:
 *   - no id_token (likely scopes weren't granted)
 *   - id_token is malformed
 *   - email is missing or not verified
 */
export function extractEmailFromTokenResponse(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const idToken = tokens.id_token;
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let payload;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  const rawEmail = payload?.email;
  if (typeof rawEmail !== "string") return null;
  const email = rawEmail.trim().toLowerCase();
  if (!email) return null;
  // Only auto-fill verified emails. Google sets email_verified on Google-hosted
  // accounts; for Workspace federation it can be false. Manual entry remains
  // available for those.
  if (payload.email_verified === false) return null;
  // Cheap final sanity check — same regex used elsewhere.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
