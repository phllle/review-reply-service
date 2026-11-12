/**
 * Printable QR review card — a counter card the business prints (2-up on
 * one sheet) so walk-in customers can scan straight to the Google
 * "write a review" page for the listing.
 *
 * buildReviewCardData is PURE: it reuses reviewRequests' reviewUrl (the
 * direct writereview link when a place_id is known, else a Maps search for
 * the business name) and derives a short displayUrl humans can fall back
 * to when they can't scan.
 *
 * The route mirrors the /reviews session gating exactly (query accountId
 * or session cookie; 401 when signed out, 403 when the session doesn't
 * own the account).
 */

import QRCode from "qrcode";
import { getBusiness } from "./businesses.js";
import { canAccessAccount, readSessionAccountId } from "./sessionAuth.js";
import { reviewUrl } from "./reviewRequests.js";
import { escapeHtml } from "./views/shell.js";

/**
 * Pure card data.
 * displayUrl: for the place_id link the full URL is far too long to print,
 * so show its host + path ("search.google.com/local/writereview") — enough
 * for a human to recognize/type the start of it. For the name-search
 * fallback there is no short link at all, so show where to search instead.
 */
export function buildReviewCardData(business) {
  const b = business || {};
  const businessName = b.name || "our business";
  const url = reviewUrl(b);
  const placeId = (b.placeId || process.env.GOOGLE_PLACE_ID || "").trim();
  const displayUrl = placeId ? "search.google.com/local/writereview" : `google.com/maps — search “${businessName}”`;
  return { businessName, reviewUrl: url, displayUrl };
}

function cardHtml({ businessName, displayUrl, qrSvg }) {
  return `<section class="rc-card">
    <div class="rc-name">${escapeHtml(businessName)}</div>
    <h1 class="rc-headline">Enjoyed your visit?</h1>
    <p class="rc-sub">Scan to leave us a Google review — it takes 30 seconds.</p>
    <div class="rc-qr">${qrSvg}</div>
    <div class="rc-url">${escapeHtml(displayUrl)}</div>
    <div class="rc-thanks">Thank you! 💬</div>
    <div class="rc-powered">Powered by <strong>Replyr</strong> · replyr.pro</div>
  </section>`;
}

/** Pure: the full printable page (screen chrome + the card rendered 2-up). */
export function buildReviewCardHtml({ businessName, displayUrl, qrSvg }) {
  const card = cardHtml({ businessName, displayUrl, qrSvg });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Review cards — ${escapeHtml(businessName)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f2f1ed; color: #17171a; font-family: 'DM Sans', sans-serif; padding: 32px 16px 48px; }
  .rc-chrome { max-width: 640px; margin: 0 auto 24px; text-align: center; }
  .rc-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; margin-bottom: 10px; }
  .rc-brand-icon { width: 28px; height: 28px; background: linear-gradient(135deg, #7c6af7, #4a9eff); border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
  .rc-chrome h1 { font-family: 'Fraunces', serif; font-weight: 400; font-size: 26px; margin-bottom: 6px; }
  .rc-chrome p { color: #666; font-size: 14px; line-height: 1.55; }
  .rc-print-btn { margin-top: 16px; background: #4a9eff; color: #0f0f11; border: none; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 700; padding: 11px 22px; cursor: pointer; }
  .rc-print-btn:hover { background: #6bafff; }
  .rc-sheet { display: flex; flex-wrap: wrap; gap: 24px; justify-content: center; }
  .rc-card { background: #fff; border: 1.5px solid #d9d7d2; border-radius: 18px; width: 4in; min-height: 6in; padding: 0.45in 0.35in; text-align: center; display: flex; flex-direction: column; align-items: center; box-shadow: 0 6px 24px rgba(0,0,0,0.06); }
  .rc-name { font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #7c6af7; margin-bottom: 18px; }
  .rc-headline { font-family: 'Fraunces', serif; font-size: 30px; font-weight: 600; line-height: 1.15; margin-bottom: 10px; }
  .rc-sub { font-size: 15px; color: #555; line-height: 1.5; margin-bottom: 26px; }
  .rc-qr { width: 2.3in; margin-bottom: 20px; }
  .rc-qr svg { width: 100%; height: auto; display: block; }
  .rc-url { font-size: 12.5px; color: #888; font-family: ui-monospace, SFMono-Regular, monospace; margin-bottom: 14px; }
  .rc-thanks { margin-top: auto; font-size: 14px; font-weight: 600; color: #17171a; }
  .rc-powered { margin-top: 10px; font-size: 11px; color: #aaa; letter-spacing: 0.02em; }
  .rc-powered strong { color: #8a8a8a; }
  @page { margin: 0.4in; }
  @media print {
    body { background: #fff; padding: 0; }
    .no-print { display: none !important; }
    .rc-sheet { gap: 0.25in; }
    .rc-card { box-shadow: none; border-color: #bbb; page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="rc-chrome no-print">
  <div class="rc-brand"><span class="rc-brand-icon" aria-hidden="true">💬</span> Replyr</div>
  <h1>Your counter review cards</h1>
  <p>Print this sheet and cut along the card edges — you get two cards per page.<br>Put one by the register and one by the door. The code takes customers straight to your Google review form.</p>
  <button type="button" class="rc-print-btn" id="rcPrintBtn">Print cards</button>
</div>
<main class="rc-sheet">
${card}
${card}
</main>
<script src="/review-card.js" defer></script>
</body>
</html>`;
}

/** Register the authenticated printable-card page. */
export function registerReviewCard(app) {
  app.get("/review-card", async (req, res, next) => {
    try {
      const accountId =
        (req.query.accountId && String(req.query.accountId).trim()) ||
        readSessionAccountId(req);
      if (!accountId) return res.status(401).json({ error: "Sign in required" });
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const locationId =
        (req.query.locationId && String(req.query.locationId).trim()) || null;
      const business = await getBusiness(accountId, locationId);
      if (!business) return res.status(404).json({ error: "Business not found." });
      const data = buildReviewCardData(business);
      const qrSvg = await QRCode.toString(data.reviewUrl, { type: "svg", margin: 1 });
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(buildReviewCardHtml({ ...data, qrSvg }));
    } catch (err) {
      next(err);
    }
  });
}
