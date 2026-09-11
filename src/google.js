import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";
import { extractEmailFromTokenResponse } from "./googleEmail.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKENS_PATH = path.resolve(__dirname, "..", "tokens.json");

// CSRF state store. In production (db.useDb()) it lives in Postgres so it
// survives restarts and works across replicas; the in-memory Map is local
// no-DB dev only.
const _oauthStates = new Map();
const _STATE_TTL_MS = 10 * 60 * 1000;

/** Pure: is a state created at createdAtMs expired relative to now? (testable) */
export function isOAuthStateExpired(createdAtMs, now = Date.now()) {
  return !createdAtMs || now - createdAtMs > _STATE_TTL_MS;
}

function pruneOAuthStates() {
  const now = Date.now();
  for (const [s, entry] of _oauthStates) {
    const ts = typeof entry === "number" ? entry : entry?.ts;
    if (isOAuthStateExpired(ts, now)) _oauthStates.delete(s);
  }
}

export async function generateState(returnTo = null) {
  const state = crypto.randomBytes(32).toString("base64url");
  const rt = returnTo && String(returnTo).trim() ? String(returnTo).trim() : null;
  if (db.useDb()) {
    await db.insertOAuthState(state, rt);
    return state;
  }
  _oauthStates.set(state, { ts: Date.now(), returnTo: rt });
  pruneOAuthStates();
  return state;
}

/** @returns {Promise<{ ok: boolean, returnTo?: string|null }>} one-time consume */
export async function validateState(state) {
  if (!state) return { ok: false };
  if (db.useDb()) {
    return await db.consumeOAuthState(String(state));
  }
  if (!_oauthStates.has(state)) return { ok: false };
  const entry = _oauthStates.get(state);
  _oauthStates.delete(state);
  const ts = typeof entry === "number" ? entry : entry?.ts;
  const returnTo = typeof entry === "object" && entry && "returnTo" in entry ? entry.returnTo : null;
  if (isOAuthStateExpired(ts)) return { ok: false };
  return { ok: true, returnTo };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

async function readTokens() {
  if (db.useDb()) {
    return await db.getTokens();
  }
  try {
    const data = await fs.readFile(TOKENS_PATH, "utf8");
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function writeTokens(data) {
  if (db.useDb()) {
    await db.writeTokens(data);
    return;
  }
  await fs.writeFile(TOKENS_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function writeTokenForAccount(accountId, tokenData) {
  if (db.useDb()) {
    await db.writeToken(accountId, tokenData);
    return;
  }
  const data = await readTokens();
  data[accountId] = tokenData;
  await writeTokens(data);
}

/** Get accountId to use when none specified (first key or legacy "google") */
function getDefaultAccountId(tokens) {
  if (tokens.google && (tokens.google.refresh_token || tokens.google.access_token)) {
    return "google";
  }
  const key = Object.keys(tokens).find(
    (k) => tokens[k] && (tokens[k].refresh_token || tokens[k].access_token)
  );
  return key || null;
}

function getTokenDataForAccount(tokens, accountId) {
  if (accountId && tokens[accountId]) {
    return tokens[accountId];
  }
  const key = accountId || getDefaultAccountId(tokens);
  if (key && tokens[key]) {
    return tokens[key];
  }
  if (tokens.google && (tokens.google.refresh_token || tokens.google.access_token)) {
    return tokens.google;
  }
  return null;
}

function createOAuthClient() {
  const client = new OAuth2Client({
    clientId: requiredEnv("GOOGLE_CLIENT_ID").trim(),
    clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET").trim(),
    redirectUri: requiredEnv("GOOGLE_REDIRECT_URI").trim()
  });
  return client;
}

/** @param {{ returnTo?: string|null }} [options] - relative path + query only, e.g. /connected?accountId=1&subscribed=1 */
export async function getAuthUrl(options = {}) {
  const client = createOAuthClient();
  // openid + email yield an id_token whose payload includes the user's email.
  // We use the email to pre-fill the auto-reply preview notification address
  // so owners don't have to re-type it on /connected.
  const scopes = [
    "https://www.googleapis.com/auth/business.manage",
    "openid",
    "email"
  ];
  const returnTo = options.returnTo && String(options.returnTo).trim().startsWith("/") ? String(options.returnTo).trim() : null;
  const state = await generateState(returnTo);
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state
  });
  return url;
}

/** Fetch accounts using a raw access token (e.g. right after OAuth) */
async function fetchAccountsWithAccessToken(accessToken) {
  const url = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Accounts API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const accounts = data.accounts || [];
  return accounts;
}

/** Fetch locations for one account using a raw access token (before tokens are stored). */
async function fetchLocationsWithAccessToken(accessToken, accountId) {
  const base = `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations?readMask=name,title,metadata`;
  let pageToken;
  const items = [];
  do {
    const url = new URL(base);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Locations API error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    if (Array.isArray(data.locations)) items.push(...data.locations);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Exchange the OAuth code and enumerate EVERY location the user can manage,
 * across ALL of their Google Business accounts. Does NOT persist any token —
 * the caller decides (via attach-by-placeId) whether this user is a new owner
 * (persist + create a business) or a manager attaching to an existing tenant
 * (keep the original owner's token untouched). Two Google users on the same
 * listing can get different account ids, so we key on placeId/locationId, not
 * accountId.
 *
 * @returns {Promise<{ tokens: object, email: string|null, primaryAccountId: string|null, primaryAccountName: string|null, candidates: Array<{accountId:string, accountName:string|null, locationId:string|null, placeId:string|null, title:string|null}> }>}
 */
export async function handleOAuthCallback(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  const accessToken = tokens.access_token;
  const accounts = await fetchAccountsWithAccessToken(accessToken);
  if (!accounts.length) {
    throw new Error("No Google Business accounts found for this user.");
  }
  const candidates = [];
  for (const acc of accounts) {
    const accId = acc.name ? acc.name.replace(/^accounts\//, "") : null;
    if (!accId) continue;
    let locs = [];
    try {
      locs = await fetchLocationsWithAccessToken(accessToken, accId);
    } catch {
      // Skip accounts whose locations we can't list (partial access); other
      // accounts may still yield a match.
      continue;
    }
    for (const loc of locs) {
      candidates.push({
        accountId: accId,
        accountName: acc.accountName || null,
        locationId: loc?.name ? loc.name.split("/").pop() : null,
        placeId: loc?.metadata?.placeId || null,
        title: loc?.title || null
      });
    }
  }
  const first = accounts[0];
  const primaryAccountId = first.name ? first.name.replace(/^accounts\//, "") : null;
  // Best-effort email capture from the id_token. Used to prefill notification_email
  // on first connect (never overwrites a value the owner already set).
  const email = extractEmailFromTokenResponse(tokens);
  return { tokens, email, primaryAccountId, primaryAccountName: first.accountName || null, candidates };
}

/** Persist OAuth tokens for an account (used when creating/refreshing a business owner). */
export async function persistTokenForAccount(accountId, tokens) {
  if (!accountId || !tokens) return;
  const existing = await readTokens();
  await writeTokenForAccount(accountId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || existing[accountId]?.refresh_token || null,
    scope: tokens.scope,
    expiry_date: tokens.expiry_date || null
  });
}

/**
 * Pure decision helper: given the OAuth user's candidate locations and lookups
 * to find an existing business by placeId (preferred) then locationId, decide
 * how to proceed. Matches attach to the existing tenant's accountId so billing,
 * Pro contacts, and the customer list all load the original business.
 *
 * @returns {Promise<{mode:"none"} | {mode:"attach", accountId:string} | {mode:"create", candidate:object} | {mode:"picker", options:Array<object>}>}
 */
export async function resolveAttachDecision(candidates, { byPlaceId, byLocationId } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { mode: "none" };
  const options = [];
  for (const c of candidates) {
    let existing = null;
    if (c.placeId && byPlaceId) existing = await byPlaceId(c.placeId);
    if (!existing && c.locationId && byLocationId) existing = await byLocationId(c.locationId);
    options.push({ ...c, attachTo: existing ? existing.accountId : null });
  }
  const attachAccounts = new Set(options.filter((o) => o.attachTo).map((o) => o.attachTo));
  const news = options.filter((o) => !o.attachTo);
  // One existing tenant and nothing new → attach straight through, no picker.
  if (news.length === 0 && attachAccounts.size === 1) {
    return { mode: "attach", accountId: [...attachAccounts][0] };
  }
  // A single brand-new location and no matches → create as today.
  if (attachAccounts.size === 0 && news.length === 1) {
    return { mode: "create", candidate: news[0] };
  }
  // Ambiguous or mixed (several matches, or new + existing) → let the user pick.
  return { mode: "picker", options };
}

async function getAuthorizedClient(accountId) {
  const client = createOAuthClient();
  const data = await readTokens();
  const tokenData = getTokenDataForAccount(data, accountId);
  if (!tokenData || !(tokenData.refresh_token || tokenData.access_token)) {
    const error = new Error("Google is not connected for this account. Visit /auth/google to connect.");
    error.status = 400;
    throw error;
  }
  client.setCredentials(tokenData);
  return client;
}

export async function getTokenStatus(accountId) {
  const data = await readTokens();
  const tokenData = getTokenDataForAccount(data, accountId);
  const accountIds = Object.keys(data).filter(
    (k) => data[k] && (data[k].refresh_token || data[k].access_token)
  );
  return {
    connected: Boolean(tokenData && (tokenData.refresh_token || tokenData.access_token)),
    scope: tokenData?.scope || null,
    expiry_date: tokenData?.expiry_date || null,
    accountIds: accountIds.length ? accountIds : undefined
  };
}

/** Get access token for an account. Pass accountId for multi-tenant; omit to use first/legacy. */
async function getAccessToken(accountId) {
  const client = await getAuthorizedClient(accountId);
  const accessTokenResponse = await client.getAccessToken();
  const data = await readTokens();
  const key = accountId || getDefaultAccountId(data);
  const tokenData = key ? data[key] : null;
  const newAccessToken = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;
  if (newAccessToken && key && tokenData) {
    const updatedTokenData = {
      ...tokenData,
      access_token: newAccessToken,
      expiry_date: client.credentials.expiry_date || tokenData.expiry_date || null
    };
    await writeTokenForAccount(key, updatedTokenData);
    return newAccessToken;
  }
  if (tokenData?.access_token) {
    return tokenData.access_token;
  }
  const error = new Error("Unable to obtain Google access token");
  error.status = 401;
  throw error;
}

export async function replyToReview(accountId, locationId, reviewId, comment) {
  const accessToken = await getAccessToken(accountId);
  const endpoint = `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews/${encodeURIComponent(reviewId)}/reply`;
  const resp = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ comment })
  });
  if (!resp.ok) {
    const text = await resp.text();
    const error = new Error(`Google API error ${resp.status}: ${text}`);
    error.status = resp.status;
    throw error;
  }
  const data = await resp.json();
  return data;
}

async function googleApiGet(url, accountId) {
  const accessToken = await getAccessToken(accountId);
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    const error = new Error(`Google API error ${resp.status}: ${text}`);
    error.status = resp.status;
    throw error;
  }
  return await resp.json();
}

async function fetchAllPages(baseUrl, itemsKey, accountId) {
  let pageToken = undefined;
  const items = [];
  do {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleApiGet(url.toString(), accountId);
    const pageItems = Array.isArray(data[itemsKey]) ? data[itemsKey] : [];
    items.push(...pageItems);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

export async function listAccounts(accountId) {
  const baseUrl = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
  return await fetchAllPages(baseUrl, "accounts", accountId);
}

export async function listLocations(accountId) {
  const baseUrl = `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations?readMask=name,title,metadata`;
  return await fetchAllPages(baseUrl, "locations", accountId);
}

export async function listReviews(accountId, locationId) {
  const baseUrl = `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews`;
  return await fetchAllPages(baseUrl, "reviews", accountId);
}
