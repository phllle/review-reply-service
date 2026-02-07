import { OAuth2Client } from "google-auth-library";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

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
  try {
    const data = await fs.readFile(TOKENS_PATH, "utf8");
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function writeTokens(tokens) {
  await fs.writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
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

export async function handleOAuthCallback(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const existing = await readTokens();
  existing.google = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || existing.google?.refresh_token || null,
    scope: tokens.scope,
    expiry_date: tokens.expiry_date || null
  };
  await writeTokens(existing);
}

async function getAuthorizedClient() {
  const client = createOAuthClient();
  const tokens = await readTokens();
  if (!tokens.google || !(tokens.google.refresh_token || tokens.google.access_token)) {
    const error = new Error("Google is not connected. Visit /auth/google to connect.");
    error.status = 400;
    throw error;
  }
  client.setCredentials(tokens.google);
  return client;
}

export async function getTokenStatus() {
  const tokens = await readTokens();
  const google = tokens.google || null;
  return {
    connected: Boolean(google && (google.refresh_token || google.access_token)),
    scope: google?.scope || null,
    expiry_date: google?.expiry_date || null
  };
}

async function getAccessToken() {
  const client = await getAuthorizedClient();
  const accessTokenResponse = await client.getAccessToken();
  const tokens = await readTokens();
  const newAccessToken = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;
  if (newAccessToken) {
    tokens.google = {
      ...tokens.google,
      access_token: newAccessToken,
      expiry_date: client.credentials.expiry_date || tokens.google.expiry_date || null
    };
    await writeTokens(tokens);
    return newAccessToken;
  }
  if (tokens.google?.access_token) {
    return tokens.google.access_token;
  }
  const error = new Error("Unable to obtain Google access token");
  error.status = 401;
  throw error;
}

export async function replyToReview(accountId, locationId, reviewId, comment) {
  const accessToken = await getAccessToken();
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

async function googleApiGet(url) {
  const accessToken = await getAccessToken();
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

async function fetchAllPages(baseUrl, itemsKey) {
  let pageToken = undefined;
  const items = [];
  do {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleApiGet(url.toString());
    const pageItems = Array.isArray(data[itemsKey]) ? data[itemsKey] : [];
    items.push(...pageItems);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

export async function listAccounts() {
  // Use Account Management API v1
  const baseUrl = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
  return await fetchAllPages(baseUrl, "accounts");
}

export async function listLocations(accountId) {
  // Use Business Information API v1; readMask is required
  const baseUrl = `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations?readMask=name,title`;
  return await fetchAllPages(baseUrl, "locations");
}

export async function listReviews(accountId, locationId) {
  const baseUrl = `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews`;
  return await fetchAllPages(baseUrl, "reviews");
}
