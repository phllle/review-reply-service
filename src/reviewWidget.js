/**
 * Website review widget — a business pastes a two-line snippet on their own
 * site and it renders their Google rating + recent reviews, with a
 * "Powered by Replyr" footer (acquisition loop + stickiness: removing
 * Replyr removes the widget).
 *
 * Access is capability-based: the embed token (businesses.widget_token,
 * generated lazily from the settings page) is the only credential. The
 * token is account-level — one token per Google account, stamped on every
 * location row; the payload shows the primary location's reviews.
 *
 * buildWidgetPayload is PURE (business + already-fetched reviews in,
 * payload out). All IO lives in loadWidgetPayload / ensureWidgetToken,
 * so the aggregation is unit-testable without Google or the DB.
 *
 * Reviews are shown at ANY rating — the widget mirrors the business's real
 * Google listing, it is not a cherry-picked highlights reel.
 */

import crypto from "crypto";
import { getBusinessByWidgetToken, getBusinessesForAccount, upsertBusiness } from "./businesses.js";
import { listReviews } from "./google.js";
import { googlePlaceUrl } from "./firstReply.js";

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const TEXT_MAX = 220;
const MAX_REVIEWS = 5;

export const WIDGET_POWERED_BY_URL = "https://replyr.pro/?utm_source=widget";

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

function truncate(text) {
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}

/** 48 hex chars from a CSPRNG — unguessable, safe to expose in page source. */
export function generateWidgetToken() {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Pure aggregation.
 * - business: a businesses row (or null → null payload)
 * - reviews: array of Google reviews (listReviews output)
 * averageRating is the mean of every review's numeric rating (1 decimal);
 * reviews[] is the 5 most recent reviews that have comment text.
 */
export function buildWidgetPayload(business, reviews) {
  if (!business) return null;
  const list = Array.isArray(reviews) ? reviews : [];
  let sum = 0;
  let counted = 0;
  for (const r of list) {
    const n = STAR[r?.starRating];
    if (n) {
      sum += n;
      counted += 1;
    }
  }
  const recent = list
    .map((r, i) => ({ r, i, t: Date.parse(r?.createTime || r?.updateTime || "") || 0 }))
    .filter(({ r }) => oneLine(r?.comment))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .slice(0, MAX_REVIEWS)
    .map(({ r }) => ({
      reviewer: oneLine(r?.reviewer?.displayName) || "Customer",
      rating: STAR[r?.starRating] || 0,
      text: truncate(oneLine(r?.comment)),
      createTime: r?.createTime || r?.updateTime || null
    }));
  return {
    businessName: business.name || "",
    averageRating: counted ? Math.round((sum / counted) * 10) / 10 : null,
    totalReviews: list.length,
    reviews: recent,
    googleUrl: googlePlaceUrl(business.placeId, business.name),
    poweredBy: WIDGET_POWERED_BY_URL
  };
}

/**
 * IO: token → business → reviews → payload. Unknown token or any failure
 * (expired Google token, Google outage) returns null — the public routes
 * turn that into a 404 / no-op so customer sites never break.
 *
 * `deps` is injectable for tests.
 */
export async function loadWidgetPayload(token, { logger = console, deps = {} } = {}) {
  try {
    const t = String(token || "").trim();
    if (!t) return null;
    const loadBusiness = deps.getBusinessByWidgetToken || getBusinessByWidgetToken;
    const business = await loadBusiness(t);
    if (!business) return null;
    const fetchReviews = deps.listReviews || listReviews;
    const reviews = (await fetchReviews(business.accountId, business.locationId)) || [];
    return buildWidgetPayload(business, reviews);
  } catch (err) {
    logger?.warn?.({ err }, "Widget: could not load payload");
    return null;
  }
}

/**
 * Return the account's widget token, generating and persisting one on every
 * location row when the account doesn't have one yet. Called when the owner
 * loads the embed-code UI on the settings page. Returns null when the
 * account has no business rows.
 *
 * `deps` is injectable for tests.
 */
export async function ensureWidgetToken(accountId, { logger = console, deps = {} } = {}) {
  const loadRows = deps.getBusinessesForAccount || getBusinessesForAccount;
  const save = deps.upsertBusiness || upsertBusiness;
  const rows = await loadRows(accountId);
  if (!rows || !rows.length) return null;
  const existing = rows.map((r) => r?.widgetToken).find(Boolean);
  if (existing) return existing;
  const token = generateWidgetToken();
  for (const row of rows) {
    await save({ accountId: row.accountId, locationId: row.locationId, widgetToken: token });
  }
  logger?.info?.({ accountId }, "Widget: generated embed token");
  return token;
}

// --- Embed snippet (client JS) --------------------------------------------------

/** Served for unknown tokens: a comment only, so customer pages never break. */
export const WIDGET_NOOP_SCRIPT = "/* Replyr widget: nothing to render. */\n";

const WIDGET_CSS = [
  ".replyr-w{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#fff;color:#1a1a1a;border:1px solid rgba(0,0,0,.1);border-radius:14px;padding:18px;max-width:560px;line-height:1.5}",
  ".replyr-w-name{font-size:17px;font-weight:700;margin-bottom:2px}",
  ".replyr-w-rating{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:#555}",
  ".replyr-w-stars{color:#f59e0b;font-size:15px;letter-spacing:1px}",
  ".replyr-w-stars-sm{font-size:12px}",
  ".replyr-w-avg{font-weight:700;color:#1a1a1a}",
  ".replyr-w-list{margin-top:12px;display:flex;flex-direction:column;gap:10px}",
  ".replyr-w-card{background:#f7f7f8;border-radius:10px;padding:12px 14px}",
  ".replyr-w-card-top{display:flex;align-items:center;gap:8px;margin-bottom:4px}",
  ".replyr-w-reviewer{font-size:13px;font-weight:600}",
  ".replyr-w-text{margin:0;font-size:13.5px;color:#333}",
  ".replyr-w-foot{margin-top:14px;font-size:12px;color:#888;display:flex;gap:6px;flex-wrap:wrap}",
  ".replyr-w-foot a{color:#4a6cf7;text-decoration:none}",
  ".replyr-w-foot a:hover{text-decoration:underline}"
].join("\n");

/**
 * The self-contained snippet served at /widget/:token.js. It locates the
 * <div data-replyr-widget> placeholder (or creates one just before the
 * script tag), fetches the JSON payload from the same origin the script was
 * served from, and builds the DOM with textContent for ALL business/review
 * text — never innerHTML — so review content can't inject markup into the
 * customer's page.
 */
export function buildWidgetScript(token) {
  return `(function () {
  var script = document.currentScript;
  if (!script) return;
  var bakedToken = ${JSON.stringify(String(token || ""))};
  var token = script.getAttribute("data-replyr-token") || bakedToken;
  if (!token) return;
  var origin = "";
  try { origin = new URL(script.src).origin; } catch (e) { origin = ""; }
  var container = document.querySelector("[data-replyr-widget]");
  if (!container) {
    container = document.createElement("div");
    container.setAttribute("data-replyr-widget", "");
    if (script.parentNode) script.parentNode.insertBefore(container, script);
  }
  if (!container) return;
  function starRow(n) {
    var f = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    var s = "";
    for (var i = 0; i < 5; i++) s += i < f ? "\\u2605" : "\\u2606";
    return s;
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function render(data) {
    if (!data || typeof data !== "object") return;
    var style = document.createElement("style");
    style.textContent = ${JSON.stringify(WIDGET_CSS)};
    container.appendChild(style);
    var root = el("div", "replyr-w");
    var head = el("div", "replyr-w-head");
    head.appendChild(el("div", "replyr-w-name", data.businessName || ""));
    var ratingRow = el("div", "replyr-w-rating");
    if (data.averageRating != null) {
      ratingRow.appendChild(el("span", "replyr-w-stars", starRow(data.averageRating)));
      ratingRow.appendChild(el("span", "replyr-w-avg", String(data.averageRating)));
    }
    ratingRow.appendChild(el("span", "replyr-w-count", "based on " + (data.totalReviews || 0) + " Google review" + (data.totalReviews === 1 ? "" : "s")));
    head.appendChild(ratingRow);
    root.appendChild(head);
    var reviews = Array.isArray(data.reviews) ? data.reviews : [];
    if (reviews.length) {
      var list = el("div", "replyr-w-list");
      reviews.forEach(function (r) {
        var card = el("div", "replyr-w-card");
        var top = el("div", "replyr-w-card-top");
        top.appendChild(el("span", "replyr-w-reviewer", (r && r.reviewer) || "Customer"));
        top.appendChild(el("span", "replyr-w-stars replyr-w-stars-sm", starRow(r && r.rating)));
        card.appendChild(top);
        card.appendChild(el("p", "replyr-w-text", (r && r.text) || ""));
        list.appendChild(card);
      });
      root.appendChild(list);
    }
    var foot = el("div", "replyr-w-foot");
    if (data.googleUrl) {
      var g = document.createElement("a");
      g.href = data.googleUrl;
      g.target = "_blank";
      g.rel = "noopener";
      g.textContent = "Read all reviews on Google";
      foot.appendChild(g);
      foot.appendChild(document.createTextNode("\\u00B7"));
    }
    var p = document.createElement("a");
    p.href = data.poweredBy || "https://replyr.pro/?utm_source=widget";
    p.target = "_blank";
    p.rel = "noopener";
    p.textContent = "Powered by Replyr";
    foot.appendChild(p);
    root.appendChild(foot);
    container.appendChild(root);
  }
  var url = (origin || "") + "/widget/" + encodeURIComponent(token) + ".json";
  fetch(url, { credentials: "omit" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(render)
    .catch(function () {});
})();
`;
}

/** Register the two public (no-session) widget routes. */
export function registerReviewWidget(app) {
  app.get("/widget/:token.json", async (req, res, next) => {
    try {
      const payload = await loadWidgetPayload(req.params.token, { logger: req.log });
      if (!payload) return res.status(404).json({ error: "Widget not found" });
      res.set("Cache-Control", "public, max-age=1800");
      // The payload is public and the token is the capability — page data is
      // fetched cross-origin from customer sites.
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  app.get("/widget/:token.js", async (req, res, next) => {
    try {
      res.set("Content-Type", "application/javascript; charset=utf-8");
      res.set("Cache-Control", "public, max-age=3600");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      const business = await getBusinessByWidgetToken(String(req.params.token || "").trim());
      if (!business) return res.send(WIDGET_NOOP_SCRIPT);
      res.send(buildWidgetScript(req.params.token));
    } catch (err) {
      next(err);
    }
  });
}
