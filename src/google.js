import { OAuth2Client } from "google-auth-library";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKENS_PATH = path.resolve(__dirname, "..", "tokens.json");

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
    clientId: requiredEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri: requiredEnv("GOOGLE_REDIRECT_URI")
  });
  return client;
}

export async function getAuthUrl() {
  const client = createOAuthClient();
  const scopes = ["https://www.googleapis.com/auth/business.manage"];
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes
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

export async function handleOAuthCallback(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  const accessToken = tokens.access_token;
  const accounts = await fetchAccountsWithAccessToken(accessToken);
  if (!accounts.length) {
    throw new Error("No Google Business accounts found for this user.");
  }
  const first = accounts[0];
  const accountId = first.name ? first.name.replace(/^accounts\//, "") : null;
  if (!accountId) {
    throw new Error("Could not determine account ID");
  }
  const existing = await readTokens();
  existing[accountId] = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || existing[accountId]?.refresh_token || null,
    scope: tokens.scope,
    expiry_date: tokens.expiry_date || null
  };
  await writeTokens(existing);
  return { accountId, accountName: first.accountName };
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
    data[key] = {
      ...tokenData,
      access_token: newAccessToken,
      expiry_date: client.credentials.expiry_date || tokenData.expiry_date || null
    };
    await writeTokens(data);
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
  const baseUrl = `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations?readMask=name,title`;
  return await fetchAllPages(baseUrl, "locations", accountId);
}

export async function listReviews(accountId, locationId) {
  const baseUrl = `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews`;
  return await fetchAllPages(baseUrl, "reviews", accountId);
}
