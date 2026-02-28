import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import * as db from "./db.js";
import { getAuthUrl, handleOAuthCallback, getTokenStatus, replyToReview, listAccounts, listLocations, listReviews } from "./google.js";
import { processPendingReviews, startScheduler, getReplyText, addRepliedReviewId } from "./auto.js";
import { getAllBusinesses, getBusiness, upsertBusiness, getAccountIdByStripeCustomerId } from "./businesses.js";
import { replaceProContacts, getProContactsCount, setProContactUnsubscribed } from "./proContacts.js";
import { parseProCsv, validateFile } from "./csvPro.js";
import { verifyUnsubscribeToken } from "./campaignEmail.js";
import { generateCampaignMessageWithClaude } from "./ai.js";
import {
  getUpcomingEvents,
  getEventSendDate,
  sendBirthdayCampaignsForAccount,
  sendEventCampaignForAccount,
  sendOneOffCampaign
} from "./proCampaigns.js";
import multer from "multer";
import Stripe from "stripe";

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

async function runCampaignScheduler() {
  if (!db.useDb()) return;
  try {
    const businesses = await getAllBusinesses();
    const proAccounts = Object.values(businesses).filter((b) => b.isPro).map((b) => b.accountId);
    for (const accountId of proAccounts) {
      try {
        await sendBirthdayCampaignsForAccount(accountId, logger);
      } catch (err) {
        logger.error({ err, accountId }, "Birthday campaign tick failed");
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    const eventDue = await db.getProEventCampaignsDueToSend();
    for (const { accountId, eventKey, eventYear } of eventDue) {
      if (getEventSendDate(eventKey, eventYear) !== today) continue;
      try {
        await sendEventCampaignForAccount(accountId, eventKey, eventYear, logger);
      } catch (err) {
        logger.error({ err, accountId, eventKey }, "Event campaign send failed");
      }
    }
    const oneOffDue = await db.getProOneOffCampaignsDueToSend();
    for (const row of oneOffDue) {
      try {
        await sendOneOffCampaign(row.id, row.account_id, row.subject, row.body, logger);
      } catch (err) {
        logger.error({ err, id: row.id }, "One-off campaign send failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "Campaign scheduler failed");
  }
}

async function start() {
  if (db.useDb()) {
    await db.init();
    logger.info("Database initialized");
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    logger.info({ port }, "Server started");
    startScheduler(logger);
    if (db.useDb()) {
      runCampaignScheduler();
      setInterval(runCampaignScheduler, 60 * 60 * 1000);
    }
  });
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (allowedOrigins.includes("*")) return callback(null, true);
    if (!origin) return callback(null, false);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(pinoHttp({ logger }));
// Stripe webhook needs raw body for signature verification (must be before express.json())
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);
app.use(express.json());
app.use(express.static("public"));

const proUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const err = validateFile(file.mimetype, file.originalname);
    if (err) cb(new Error(err));
    else cb(null, true);
  }
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// Test failure alert (sends a sample email/SMS). Set TEST_ALERT_SECRET in env, then: GET /test-alert?secret=YOUR_SECRET
app.get("/test-alert", async (req, res, next) => {
  try {
    const secret = (req.query.secret || "").trim();
    const expected = process.env.TEST_ALERT_SECRET?.trim();
    if (!expected || secret !== expected) {
      return res.status(400).json({ error: "Missing or invalid secret. Set TEST_ALERT_SECRET and use ?secret= that value." });
    }
    const { sendFailureAlert } = await import("./alert.js");
    await sendFailureAlert({
      businessName: "Test Business",
      accountId: "test-account",
      error: new Error("This is a test alert. If you got this, failure alerts are working.")
    });
    res.json({ ok: true, message: "Test alert sent. Check " + (process.env.ALERT_EMAIL || "ALERT_EMAIL") + " (and phone if configured)." });
  } catch (err) {
    req.log?.error(err, "Test alert failed");
    next(err);
  }
});

async function stripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    req.log?.warn("STRIPE_WEBHOOK_SECRET not set, skipping webhook");
    return res.status(200).send();
  }
  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("Missing stripe-signature");
  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    req.log?.warn({ err: err.message }, "Stripe webhook signature verification failed");
    return res.status(400).send("Webhook signature verification failed");
  }
  const stripeProPriceId = (process.env.STRIPE_PRO_PRICE_ID || "").trim();

  function subscriptionHasProPrice(subscription) {
    if (!stripeProPriceId || !subscription?.items?.data) return false;
    return subscription.items.data.some((item) => (item.price?.id || item.price) === stripeProPriceId);
  }

  async function applySubscriptionState(accountId, subscribedAt, isPro) {
    if (!accountId) return;
    const business = await getBusiness(accountId);
    if (business) {
      await upsertBusiness({ ...business, subscribedAt: subscribedAt || null, isPro: !!isPro });
    }
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const accountId = session.client_reference_id;
      const customerId = typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
      let isPro = false;
      if (stripeProPriceId && session.subscription) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
          const sub = await stripe.subscriptions.retrieve(session.subscription, { expand: ["items.data.price"] });
          isPro = subscriptionHasProPrice(sub);
        } catch (e) {
          req.log?.warn({ err: e.message }, "Could not retrieve subscription for Pro check");
        }
      }
      if (accountId) {
        const business = await getBusiness(accountId);
        if (business) {
          await upsertBusiness({
            ...business,
            subscribedAt: new Date().toISOString(),
            stripeCustomerId: customerId,
            isPro
          });
          req.log?.info({ accountId, customerId, isPro }, "Stripe: subscription recorded");
        }
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
      const accountId = customerId ? await getAccountIdByStripeCustomerId(customerId) : null;
      const isPro = subscriptionHasProPrice(subscription);
      const subscribedAt = subscription.status === "active" ? new Date().toISOString() : null;
      await applySubscriptionState(accountId, subscribedAt, isPro);
      if (accountId) req.log?.info({ accountId, isPro }, "Stripe: subscription updated");
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
      if (customerId) {
        const accountId = await getAccountIdByStripeCustomerId(customerId);
        if (accountId) {
          const business = await getBusiness(accountId);
          if (business) {
            await upsertBusiness({ ...business, subscribedAt: null, isPro: false });
            req.log?.info({ accountId }, "Stripe: subscription removed");
          }
        }
      }
    }
  } catch (err) {
    req.log?.error({ err }, "Stripe webhook handler error");
    return res.status(500).send("Webhook handler failed");
  }
  res.status(200).send();
}

// Create Stripe Checkout Session (so we can pass accountId and get it back in webhook). Body: { accountId, plan?: 'pro' }.
app.post("/create-checkout-session", async (req, res, next) => {
  try {
    const { accountId, plan } = req.body || {};
    const secret = process.env.STRIPE_SECRET_KEY;
    const isPro = plan === "pro";
    const priceId = isPro ? (process.env.STRIPE_PRO_PRICE_ID || "").trim() : process.env.STRIPE_PRICE_ID;
    const baseUrl = (process.env.BASE_URL || "").trim() || `${req.protocol}://${req.get("host") || ""}`;
    if (!secret || !priceId) {
      return res.status(503).json({
        error: isPro ? "Replyr Pro is not configured (STRIPE_PRO_PRICE_ID). Contact us." : "Stripe not configured. Use the Subscribe link below."
      });
    }
    if (!accountId || typeof accountId !== "string") {
      return res.status(400).json({ error: "accountId is required" });
    }
    const business = await getBusiness(accountId);
    if (!business) {
      return res.status(404).json({ error: "Business not found. Connect via the signup link first." });
    }
    const stripe = new Stripe(secret);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: accountId,
      success_url: `${baseUrl.replace(/\/$/, "")}/connected?accountId=${encodeURIComponent(accountId)}&subscribed=1`,
      cancel_url: `${baseUrl.replace(/\/$/, "")}/subscribe?accountId=${encodeURIComponent(accountId)}`
    });
    res.json({ url: session.url });
  } catch (err) {
    req.log?.error(err, "Create checkout session failed");
    next(err);
  }
});

// Signup/landing page – connect with Google
function signupPageHtml() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Replyr – Get started</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem 1rem; background: #f5f5f5; gap: 2rem; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 420px; text-align: center; }
    .examples { max-width: 960px; width: 100%; }
    .examples h2 { font-size: 1rem; color: #333; margin: 0 0 0.5rem; text-align: center; font-weight: 600; }
    .examples p:first-of-type { text-align: center; color: #666; font-size: 0.9rem; margin: 0 0 1rem; }
    .examples-row { display: flex; gap: 1rem; justify-content: center; align-items: stretch; flex-wrap: wrap; }
    .examples-row img { width: 100%; max-width: 300px; height: 420px; object-fit: contain; object-position: top; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); display: block; background: #fafafa; }
    .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 0.25rem; }
    .logo { width: 36px; height: 36px; flex-shrink: 0; }
    .logo svg { width: 100%; height: 100%; display: block; }
    .brand-name { font-size: 1.75rem; font-weight: 700; color: #2C2D32; letter-spacing: -0.02em; }
    .tagline { margin: 0 0 1rem; color: #555; line-height: 1.5; font-size: 0.95rem; }
    .features { text-align: left; margin: 0 0 1.5rem; padding: 0 0.5rem; }
    .features ul { margin: 0; padding: 0; list-style: none; }
    .features li { position: relative; padding-left: 1.25rem; margin-bottom: 0.5rem; color: #444; font-size: 0.9rem; line-height: 1.4; }
    .features li::before { content: ""; position: absolute; left: 0; top: 0.4em; width: 6px; height: 6px; background: #2160F3; border-radius: 50%; }
    a.btn { display: inline-block; padding: 0.75rem 1.5rem; background: #333; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 500; }
    a.btn:hover { background: #555; }
    .manage-link { display: block; margin-top: 0.75rem; color: #2160F3; text-decoration: none; font-size: 0.9rem; }
    .manage-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="logo" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="6" width="24" height="14" rx="4" fill="#2160F3"/><polygon points="12,20 20,20 16,27" fill="#2160F3"/><line x1="12" y1="12" x2="28" y2="12" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></div>
      <span class="brand-name">Replyr</span>
    </div>
    <p class="tagline">Your AI reply assistant for Google reviews</p>
    <p style="margin:0 0 1rem;color:#555;line-height:1.5;font-size:0.9rem;">Connect your Google Business Profile to reply to reviews from one place, or turn on automatic replies.</p>
    <div class="features">
      <ul>
        <li><strong>Auto-reply</strong> — We reply to new 1–5 star reviews on a schedule you set.</li>
        <li><strong>Your voice</strong> — Add your contact (e.g. phone) for 1–2 star replies so customers can reach you.</li>
        <li><strong>Shows as owner</strong> — Replies appear as “[Your business] (Owner)” on Google.</li>
        <li><strong>One connection</strong> — Connect once; we keep replying until you turn it off.</li>
      </ul>
    </div>
    <a href="/auth/google" class="btn">Connect with Google</a>
    <a href="/dashboard" class="manage-link">Already connected? Manage your account</a>
  </div>
  <section class="examples" aria-label="Example reviews">
    <h2>See it in action</h2>
    <p style="text-align:center;color:#666;font-size:0.9rem;margin:0 0 1rem;">Real Google reviews and replies from Castle Nail Bar, powered by Replyr.</p>
    <div class="examples-row">
      <img src="/review-example-1.png" alt="Google review with 5 stars and owner reply from Castle Nail Bar" loading="lazy">
      <img src="/review-example-2.png" alt="Google review with 5 stars and owner reply from Castle Nail Bar" loading="lazy">
      <img src="/review-example-3.png" alt="Google review with 5 stars and owner reply from Castle Nail Bar" loading="lazy">
    </div>
  </section>
</body>
</html>
  `;
}
app.get("/", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(signupPageHtml());
});
app.get("/signup", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(signupPageHtml());
});

// Shown when user connects with Google but has no Business Profile (or no location)
app.get("/no-business", (req, res) => {
  const reason = (req.query.reason || "").trim();
  const isNoLocation = reason === "no_location";
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replyr – No business profile</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 440px; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; color: #333; }
  p { color: #555; line-height: 1.6; margin: 0 0 1rem; font-size: 0.95rem; }
  a { color: #2160F3; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .btn { display: inline-block; margin-top: 0.5rem; padding: 0.6rem 1.2rem; background: #333; color: #fff; border-radius: 8px; font-size: 0.95rem; }
  .btn:hover { background: #555; text-decoration: none; color: #fff; }
</style>
</head>
<body>
  <div class="card">
    <h1>No Google Business Profile</h1>
    ${isNoLocation
      ? "<p>Your Google account is connected, but there’s no business location linked yet. Replyr needs a Google Business Profile (and at least one location) to reply to reviews.</p><p>Create or complete your <a href=\"https://business.google.com\" target=\"_blank\" rel=\"noopener\">Google Business Profile</a>, then try connecting again.</p>"
      : "<p>Replyr works with <strong>Google Business Profile</strong>. The Google account you signed in with doesn’t have access to any business profile (or doesn’t own or manage one).</p><p>If you have a business, create or claim your listing at <a href=\"https://business.google.com\" target=\"_blank\" rel=\"noopener\">business.google.com</a>, then connect again. If you were just exploring, no problem — you can go back to the homepage.</p>"}
    <p><a href="/" class="btn">Back to Replyr</a></p>
  </div>
</body></html>`);
});

// Dashboard: re-run Google sign-in and land back on /connected
app.get("/dashboard", async (req, res, next) => {
  try {
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (err) {
    req.log.error(err, "Failed to get Google auth URL");
    next(err);
  }
});

// Success page after OAuth (callback redirects here)
app.get("/connected", async (req, res, next) => {
  try {
    const nameFromQuery = (req.query.name && String(req.query.name).trim()) || "";
    const accountId = (req.query.accountId && String(req.query.accountId).trim()) || null;
    const justSubscribed = req.query.subscribed === "1";
    let currentContact = "";
    let currentAutoReply = false;
    let businessName = "";
    let trialEndsAt = null;
    let trialDaysLeft = null;
    let trialEndDateFormatted = "";
    let subscribedAt = null;
    let trialEndedNoSubscription = false;
    let isPro = false;
    if (accountId) {
      let business = await getBusiness(accountId);
      // Backfill trial for existing businesses that connected before trial existed
      if (business && (business.trialEndsAt == null || business.trialEndsAt === "")) {
        const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await upsertBusiness({ ...business, trialEndsAt: endsAt });
        business = { ...business, trialEndsAt: endsAt };
      }
      currentContact = (business && business.contact) ? String(business.contact) : "";
      businessName = (business && business.name) ? String(business.name) : "";
      subscribedAt = business?.subscribedAt ?? null;
      if (business && business.trialEndsAt) {
        const end = new Date(business.trialEndsAt);
        trialEndsAt = business.trialEndsAt;
        trialDaysLeft = Math.ceil((end - new Date()) / (24 * 60 * 60 * 1000));
        trialEndDateFormatted = end.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
      }
      isPro = !!(business && business.isPro);
      trialEndedNoSubscription =
        trialEndsAt != null && trialDaysLeft != null && trialDaysLeft < 0 && !subscribedAt;
      if (trialEndedNoSubscription && business && business.autoReplyEnabled) {
        await upsertBusiness({ ...business, autoReplyEnabled: false });
        currentAutoReply = false;
      } else {
        currentAutoReply = !!(business && business.autoReplyEnabled);
      }
    }
    const displayName = nameFromQuery || businessName || "your business";
    const contactUs = process.env.REPLYR_CONTACT || ""; // e.g. "hello@replyr.com" or "https://..."
    const billingPortalUrl = (process.env.STRIPE_CUSTOMER_PORTAL_URL || "").trim();
    const hasBillingPortal = billingPortalUrl.startsWith("http");
    const nextStepLine = contactUs
      ? `Questions? Contact us at <a href="${contactUs.startsWith("http") ? escapeHtml(contactUs) : "mailto:" + escapeHtml(contactUs)}">${escapeHtml(contactUs)}</a>.`
      : "";
    const trialEndingSoon =
      trialEndsAt != null &&
      !subscribedAt &&
      trialDaysLeft != null &&
      trialDaysLeft >= 0 &&
      trialDaysLeft <= 7;
    const trialCard =
      trialEndsAt != null
        ? `<section class="free-reply trial-card ${trialEndedNoSubscription ? "trial-ended" : ""}">
  <h2>${trialEndedNoSubscription ? "Trial ended" : "Your 30-day free trial"}</h2>
  ${trialEndedNoSubscription ? `<p class="trial-ended-msg">Subscribe to re-enable auto-reply. <a href="/subscribe${accountId ? "?accountId=" + encodeURIComponent(accountId) : ""}" class="trial-link">View plans</a></p>` : `<p class="trial-countdown"><strong>${trialDaysLeft != null && trialDaysLeft >= 0 ? escapeHtml(String(trialDaysLeft)) : "0"} days left</strong></p>
  <p class="trial-end">${trialDaysLeft != null && trialDaysLeft >= 0 ? "Ends " : "Ended "}${escapeHtml(trialEndDateFormatted)}</p>
  ${trialEndingSoon ? `<p class="trial-ending-soon">Your trial ends in ${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"}. <a href="/subscribe${accountId ? "?accountId=" + encodeURIComponent(accountId) : ""}" class="trial-link">Subscribe</a> to keep auto-reply.</p>` : `<p class="trial-upgrade">Upgrade to keep auto-reply after your trial. <a href="/subscribe${accountId ? "?accountId=" + encodeURIComponent(accountId) : ""}" class="trial-link">View plans</a></p>`}`}
</section>`
        : "";
    const freeReplySection = accountId
      ? `${trialCard}<section class="free-reply auto-reply-section" data-account-id="${escapeHtml(accountId)}" data-trial-ended="${trialEndedNoSubscription ? "1" : "0"}">
  <h2>Auto-reply</h2>
  <p class="toggle-row">
    <label class="toggle-label">
      <input type="checkbox" id="auto-reply-toggle" ${currentAutoReply ? "checked" : ""} ${trialEndedNoSubscription ? "disabled" : ""}>
      <span class="toggle-text">Reply to new Google reviews automatically</span>
    </label>
  </p>
  ${trialEndedNoSubscription ? '<p class="trial-gate-msg">Subscribe to re-enable auto-reply.</p>' : ""}
  <p id="auto-reply-msg" class="free-reply-msg" aria-live="polite"></p>
</section>
<section id="free-reply-section" class="free-reply" data-account-id="${escapeHtml(accountId)}">
  <h2>Try it now</h2>
  <p>We'll reply to your latest unreplied review once, free. You'll see it on your Google listing.</p>
  <button type="button" id="free-reply-btn" class="btn">Send my 1 free reply</button>
  <p id="free-reply-msg" class="free-reply-msg" aria-live="polite"></p>
</section>
<section class="free-reply contact-section" data-account-id="${escapeHtml(accountId)}">
  <h2>Contact for 1–2 star replies</h2>
  <p>If a customer leaves a low rating, we'll suggest they reach out. Add your phone or email so the reply uses your real contact.</p>
  <input type="text" id="contact-input" class="contact-input" value="${escapeHtml(currentContact)}" placeholder="e.g. (425) 555-0123 or you@business.com">
  <button type="button" id="contact-save-btn" class="btn btn-secondary">Save contact</button>
  <p id="contact-msg" class="free-reply-msg" aria-live="polite"></p>
</section>
<section id="pro-contacts-section" class="free-reply pro-contacts-section" data-account-id="${escapeHtml(accountId)}" data-is-pro="${isPro ? "1" : "0"}">
  <h2>Replyr Pro – Customer list</h2>
  ${isPro
    ? `<p class="pro-desc">Upload a CSV of customers for future promos and birthday messages. <strong>Required:</strong> <code>email</code>. <strong>Recommended:</strong> <code>first_name</code> or <code>name</code>, <code>birthday</code> or <code>birth_date</code> (e.g. YYYY-MM-DD or MM/DD). <strong>Optional:</strong> <code>phone</code>. Max 5MB. Uploading replaces your current list. By uploading and sending you confirm you have permission to email these contacts. <a href="/compliance">Compliance</a>.</p>
  <div class="pro-upload-row">
    <input type="file" id="pro-csv-input" accept=".csv,text/csv,text/plain" aria-label="Choose CSV file">
    <button type="button" id="pro-upload-btn" class="btn">Upload CSV</button>
  </div>
  <div id="pro-mapping-wrap" class="pro-mapping-wrap" style="display:none;">
    <p class="pro-mapping-label">Map your columns (we auto-detect common names):</p>
    <div class="pro-mapping-row"><label>Email <span aria-hidden="true">*</span></label><select id="pro-map-email" data-field="email"></select></div>
    <div class="pro-mapping-row"><label>First name</label><select id="pro-map-first_name" data-field="first_name"><option value="">— Don't use —</option></select></div>
    <div class="pro-mapping-row"><label>Birthday</label><select id="pro-map-birthday" data-field="birthday"><option value="">— Don't use —</option></select></div>
    <div class="pro-mapping-row"><label>Phone</label><select id="pro-map-phone" data-field="phone"><option value="">— Don't use —</option></select></div>
  </div>
  <p id="pro-upload-msg" class="free-reply-msg" aria-live="polite"></p>
  <p id="pro-contacts-count" class="pro-count"></p>
  <p><a href="/pro?accountId=${encodeURIComponent(accountId)}">Manage campaigns</a> (birthday, events, one-off)</p>`
    : `<p class="pro-desc">Replyr Pro turns your customer list into automated, personal outreach. This is included in <strong>Replyr Pro</strong>.</p>
  <ul class="pro-benefits">
    <li><strong>Customer database</strong> — Upload a CSV (email, name, birthday, phone). We store it securely per business.</li>
    <li><strong>Birthday messages</strong> — We automatically email customers on their birthday. Add a coupon (e.g. 20% off their next visit) or any offer you choose.</li>
    <li><strong>Holiday & event campaigns</strong> — Mothers Day, Fathers Day, and more. Replyr sends your announcement in advance (e.g. a week before). You pick the discount or message.</li>
    <li><strong>Your voice or ours</strong> — Curate the message yourself or let Replyr write it. Include any discount, coupon, or announcement.</li>
    <li><strong>Sent on your behalf</strong> — Emails go out with your business name so customers see it as from you. Replies go to your contact email.</li>
  </ul>
  <p class="pro-compliance">By uploading and sending you confirm you have permission to email those contacts. <a href="/compliance">Compliance</a>.</p>
  <p><a href="/subscribe?accountId=${encodeURIComponent(accountId)}" class="trial-link">Upgrade to Pro</a> to unlock the customer list and automated campaigns.</p>`}
</section>`
      : "";
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connected – Replyr</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem; background: #f5f5f5; gap: 1.25rem; }
    .connected-grid { display: grid; grid-template-columns: 1fr; gap: 1rem; max-width: 880px; width: 100%; }
    @media (min-width: 680px) {
      .connected-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .connected-grid .card-span-full { grid-column: 1 / -1; justify-self: center; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 420px; width: 100%; text-align: center; }
    .card .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 1rem; }
    .card .logo { width: 36px; height: 36px; flex-shrink: 0; }
    .card .logo svg { width: 100%; height: 100%; display: block; }
    .card .brand-name { font-size: 1.25rem; font-weight: 700; color: #2C2D32; letter-spacing: -0.02em; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; color: #222; }
    p { margin: 0; color: #555; line-height: 1.5; font-size: 0.95rem; }
    .next-step { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.9rem; color: #555; }
    .next-step a { color: #2160F3; text-decoration: none; }
    .next-step a:hover { text-decoration: underline; }
    .connected-grid .free-reply { max-width: none; }
    .free-reply { background: #fff; padding: 1.5rem 2.5rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 420px; width: 100%; text-align: center; }
    .free-reply h2 { margin: 0 0 0.5rem; font-size: 1.1rem; color: #222; }
    .free-reply p { margin-bottom: 1rem; }
    .free-reply .btn { padding: 0.6rem 1.2rem; background: #2160F3; color: #fff; border: none; border-radius: 8px; font-size: 0.95rem; font-weight: 500; cursor: pointer; }
    .free-reply .btn:hover:not(:disabled) { background: #1d4ed8; }
    .free-reply .btn:disabled { opacity: 0.7; cursor: not-allowed; }
    .free-reply-msg { margin-top: 0.75rem; font-size: 0.9rem; min-height: 1.4em; }
    .contact-section { margin-top: 0.5rem; }
    .contact-input { width: 100%; max-width: 20rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95rem; }
    .btn-secondary { background: #555; margin-top: 0; }
    .btn-secondary:hover:not(:disabled) { background: #333; }
    .toggle-row { margin: 0.5rem 0 0; text-align: left; }
    .toggle-label { display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; }
    .toggle-label input { width: 1.1rem; height: 1.1rem; accent-color: #2160F3; }
    .toggle-text { font-size: 0.95rem; color: #333; }
    .trial-card { background: linear-gradient(135deg, #f0f7ff 0%, #e8f0fe 100%); border: 1px solid #c2dbfe; }
    .trial-countdown { font-size: 1.25rem; color: #1a73e8; margin: 0.25rem 0; }
    .trial-end { font-size: 0.9rem; color: #555; margin: 0; }
    .trial-upgrade { margin-top: 1rem; font-size: 0.9rem; color: #444; }
    .trial-link { color: #1a73e8; font-weight: 600; text-decoration: none; }
    .trial-link:hover { text-decoration: underline; }
    .trial-card.trial-ended { background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%); border-color: #ffb74d; }
    .trial-ended-msg { font-size: 0.95rem; color: #e65100; margin: 0.25rem 0 0; }
    .trial-gate-msg { font-size: 0.85rem; color: #c62828; margin: 0.25rem 0 0; }
    .trial-ending-soon { margin-top: 0.5rem; padding: 0.5rem 0.75rem; background: #fff8e1; border-radius: 6px; font-size: 0.9rem; color: #f57f17; }
    .trial-ending-soon a { color: #1a73e8; font-weight: 600; text-decoration: none; }
    .pro-contacts-section { text-align: left; }
    .pro-contacts-section .pro-desc { font-size: 0.85rem; color: #555; margin-bottom: 1rem; }
    .pro-contacts-section .pro-desc code { background: #eee; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }
    .pro-upload-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
    .pro-upload-row input[type="file"] { font-size: 0.9rem; }
    .pro-mapping-wrap { margin-top: 1rem; padding: 0.75rem; background: #f9f9f9; border-radius: 8px; font-size: 0.9rem; }
    .pro-mapping-label { margin: 0 0 0.5rem; color: #555; }
    .pro-mapping-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; }
    .pro-mapping-row label { min-width: 6rem; }
    .pro-mapping-row select { flex: 1; max-width: 12rem; padding: 0.25rem 0.5rem; }
    .pro-count { font-size: 0.9rem; color: #444; margin-top: 0.5rem; }
    .pro-benefits { margin: 0.75rem 0 1rem; padding-left: 1.25rem; font-size: 0.9rem; color: #444; line-height: 1.5; }
    .pro-benefits li { margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <div class="connected-grid">
    <div class="card card-span-full">
      <div class="brand">
        <div class="logo" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="6" width="24" height="14" rx="4" fill="#2160F3"/><polygon points="12,20 20,20 16,27" fill="#2160F3"/><line x1="12" y1="12" x2="28" y2="12" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></div>
        <span class="brand-name">Replyr</span>
      </div>
      <h1>You're connected</h1>
    ${justSubscribed ? '<p style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:#e8f5e9;border-radius:8px;color:#2e7d32;font-size:0.95rem;">Thanks for subscribing. Auto-reply will continue after your trial.</p>' : ""}
    <p>${escapeHtml(displayName)} is set up. We'll help you reply to Google reviews from here.</p>
    <p style="margin-top:0.75rem;color:#666;line-height:1.5;font-size:0.9rem;">Come back anytime via <a href="/dashboard" style="color:#2160F3;text-decoration:none;">Dashboard</a> (we’ll have you sign in with Google again).</p>
    ${hasBillingPortal ? `<p style="margin-top:0.5rem;font-size:0.9rem;"><a href="${escapeHtml(billingPortalUrl)}" style="color:#2160F3;text-decoration:none;" target="_blank" rel="noopener">Manage billing</a></p>` : ""}
    ${nextStepLine ? `<p class="next-step">${nextStepLine}</p>` : ""}
    </div>
    ${freeReplySection}
  </div>
  <script src="/connected.js"></script>
</body>
</html>
  `);
  } catch (err) {
    next(err);
  }
});

// Subscribe / upgrade page – plan details and link to Stripe or contact
app.get("/subscribe", (req, res) => {
  const subscribeUrl = process.env.SUBSCRIBE_URL || ""; // Stripe Payment Link or Checkout URL
  const contact = process.env.REPLYR_CONTACT || "";
  const priceLabel = process.env.SUBSCRIBE_PRICE || "Custom"; // e.g. "$15 / month"
  const proPriceLabel = (process.env.SUBSCRIBE_PRO_PRICE || "").trim() || "Custom"; // e.g. "$29 / month"
  const stripeProPriceId = (process.env.STRIPE_PRO_PRICE_ID || "").trim();
  const subscribeProUrl = (process.env.SUBSCRIBE_PRO_URL || "").trim(); // Stripe Payment Link for Replyr Pro (e.g. https://buy.stripe.com/...)
  const hasProPrice = Boolean(stripeProPriceId);
  const hasProPaymentLink = subscribeProUrl.startsWith("http");
  const hasPro = hasProPrice || hasProPaymentLink;
  const billingPortalUrl = (process.env.STRIPE_CUSTOMER_PORTAL_URL || "").trim();
  const accountId = (req.query.accountId && String(req.query.accountId).trim()) || "";
  const hasStripe = (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID) || subscribeUrl.startsWith("http");
  const hasBillingPortal = billingPortalUrl.startsWith("http");
  const ctaHref = subscribeUrl.startsWith("http") ? subscribeUrl : (contact.startsWith("http") ? contact : (contact ? "mailto:" + contact : "#"));
  const ctaText = hasStripe ? "Subscribe to Replyr" : "Contact us to subscribe";
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Subscribe – Replyr</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; background: #f5f5f5; }
    .subscribe-page { max-width: 440px; width: 100%; }
    .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 0.5rem; }
    .logo { width: 36px; height: 36px; flex-shrink: 0; }
    .logo svg { width: 100%; height: 100%; display: block; }
    .brand-name { font-size: 1.5rem; font-weight: 700; color: #2C2D32; letter-spacing: -0.02em; }
    h1 { font-size: 1.5rem; color: #222; margin: 0 0 0.25rem; text-align: center; }
    .tagline { color: #555; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem; text-align: center; }
    .plan-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 12px; padding: 1.5rem 1.75rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .plan-card h2 { margin: 0 0 0.35rem; font-size: 1.15rem; color: #222; }
    .plan-desc { color: #555; font-size: 0.9rem; margin: 0 0 1rem; line-height: 1.4; }
    .plan-price { font-size: 1.75rem; font-weight: 700; color: #111; margin: 0 0 0.25rem; }
    .plan-price-note { font-size: 0.8rem; color: #666; margin: 0 0 1rem; }
    .plan-features { list-style: none; margin: 0; padding: 0; }
    .plan-features li { position: relative; padding-left: 1.25rem; margin-bottom: 0.4rem; color: #444; font-size: 0.9rem; }
    .plan-features li::before { content: ""; position: absolute; left: 0; top: 0.45em; width: 6px; height: 6px; background: #2160F3; border-radius: 50%; }
    .cta-wrap { text-align: center; margin-top: 1.25rem; }
    .cta-msg { word-break: break-word; }
    a.cta-btn, button.cta-btn { display: inline-block; padding: 0.75rem 1.5rem; background: #2160F3; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 1rem; }
    a.cta-btn:hover, button.cta-btn:hover { background: #1d4ed8; }
    .back { text-align: center; margin-top: 1rem; }
    .back a { color: #2160F3; text-decoration: none; font-size: 0.9rem; }
    .back a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="subscribe-page" data-account-id="${escapeHtml(accountId)}" data-fallback-url="${escapeHtml(ctaHref)}" data-pro-url="${escapeHtml(subscribeProUrl)}" data-pro-use-checkout="${hasProPrice ? "1" : "0"}">
    <div class="brand">
      <div class="logo" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="6" width="24" height="14" rx="4" fill="#2160F3"/><polygon points="12,20 20,20 16,27" fill="#2160F3"/><line x1="12" y1="12" x2="28" y2="12" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></div>
      <span class="brand-name">Replyr</span>
    </div>
    <h1>Subscribe</h1>
    <p class="tagline">Keep auto-reply after your trial. One plan, simple pricing.</p>
    <div class="plan-card">
      <h2>Replyr</h2>
      <p class="plan-desc">For businesses that want automatic, professional replies to every new Google review.</p>
      <p class="plan-price">${escapeHtml(priceLabel)}</p>
      ${hasStripe ? "" : '<p class="plan-price-note">We\'ll send you a secure payment link.</p>'}
      <ul class="plan-features">
        <li>Auto-reply to new 1–5 star reviews</li>
        <li>Your contact in 1–2 star replies</li>
        <li>Replies show as “[Your business] (Owner)”</li>
        <li>One connection, no extra setup</li>
      </ul>
      <div class="cta-wrap">
        <button type="button" id="subscribe-cta" class="cta-btn" style="border:none;cursor:pointer;font:inherit;" data-plan="">${escapeHtml(ctaText)}</button>
        <p id="subscribe-cta-msg" class="cta-msg" style="margin-top:0.5rem;font-size:0.9rem;min-height:1.2em;color:#c62828;" aria-live="polite"></p>
      </div>
    </div>
    ${hasPro ? `<div class="plan-card plan-card-pro">
      <h2>Replyr Pro</h2>
      <p class="plan-desc">Everything in Replyr, plus a customer database and automated campaigns: birthday messages and holiday promos (Mothers Day, Fathers Day, etc.). You choose the coupon or message; Replyr sends it.</p>
      <p class="plan-price">${escapeHtml(proPriceLabel)}</p>
      <ul class="plan-features">
        <li>Everything in Replyr</li>
        <li>Upload customer CSV (email, name, birthday, phone)</li>
        <li>Automated birthday emails with your chosen coupon (e.g. 20% off)</li>
        <li>Event campaigns (e.g. a week before Mothers Day, Fathers Day) with your discount or announcement</li>
        <li>Curate the message yourself or let Replyr write it</li>
        <li>Emails show your business name; replies go to your contact email</li>
      </ul>
      <div class="cta-wrap">
        <button type="button" id="subscribe-pro-cta" class="cta-btn" style="border:none;cursor:pointer;font:inherit;" data-plan="pro">Subscribe to Replyr Pro</button>
        <p id="subscribe-pro-cta-msg" class="cta-msg" style="margin-top:0.5rem;font-size:0.9rem;min-height:1.2em;color:#c62828;" aria-live="polite"></p>
      </div>
    </div>` : ""}
    ${hasBillingPortal ? `<p class="back" style="margin-bottom:0.5rem;"><a href="${escapeHtml(billingPortalUrl)}" target="_blank" rel="noopener">Manage billing / subscription</a></p>` : ""}
    <p class="back"><a href="/">← Back to Replyr</a></p>
  </div>
  <script src="/subscribe.js"></script>
</body>
</html>
  `);
});

// Subscribe page script (external so CSP allows it; inline script was blocked)
app.get("/subscribe.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.send(`
(function() {
  var page = document.querySelector(".subscribe-page");
  if (!page) return;
  var accountId = (page.getAttribute("data-account-id") || "").trim();
  var fallbackUrl = (page.getAttribute("data-fallback-url") || "").trim() || "#";
  function go(url, openInNewTab, msgEl) {
    if (!url || url === "#" || url.indexOf("http") !== 0) {
      if (msgEl) { msgEl.textContent = "Subscribe link not set up. Add STRIPE_SECRET_KEY + STRIPE_PRICE_ID for Checkout."; }
      return;
    }
    if (openInNewTab) {
      var w = window.open(url, "_blank", "noopener,noreferrer");
      if (w) {
        if (msgEl) msgEl.textContent = "Opened in a new tab. Complete payment there.";
      } else {
        if (msgEl) msgEl.textContent = "Redirecting… (allow popups if you prefer a new tab)";
        window.location.href = url;
      }
    } else {
      window.location.href = url;
    }
  }
  var proUrl = (page.getAttribute("data-pro-url") || "").trim();
  var proUseCheckout = page.getAttribute("data-pro-use-checkout") === "1";
  function bindSubscribe(btn, msgEl, plan) {
    if (!btn) return;
    btn.addEventListener("click", function() {
      if (msgEl) msgEl.textContent = "";
      if (plan === "pro" && proUrl && !proUseCheckout) {
        go(proUrl, false, msgEl);
        return;
      }
      if (plan === "pro" && proUseCheckout && !accountId) {
        if (msgEl) msgEl.textContent = "Sign in via Dashboard first so we can link Pro to your business.";
        return;
      }
      if (!accountId && !plan) { go(fallbackUrl, false, msgEl); return; }
      btn.disabled = true;
      if (msgEl) msgEl.textContent = "Redirecting to checkout…";
      var body = { accountId: accountId };
      if (plan) body.plan = plan;
      fetch("/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }).catch(function() { return { ok: false, data: null }; }); }).then(function(result) {
        if (result.data && result.data.url) { go(result.data.url, false, msgEl); return; }
        if (!result.ok && result.data && result.data.error && msgEl) msgEl.textContent = result.data.error;
        go(fallbackUrl, false, msgEl);
      }).catch(function() {
        if (msgEl) msgEl.textContent = "Request failed. Redirecting…";
        go(fallbackUrl, false, msgEl);
      }).finally(function() { btn.disabled = false; });
    });
  }
  bindSubscribe(document.getElementById("subscribe-cta"), document.getElementById("subscribe-cta-msg"), "");
  bindSubscribe(document.getElementById("subscribe-pro-cta"), document.getElementById("subscribe-pro-cta-msg"), "pro");
})();
`);
});

app.get("/connected.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.send(`
(function() {
  var aidEl = document.querySelector("[data-account-id]");
  var accountId = aidEl ? aidEl.getAttribute("data-account-id") : null;
  var section = document.getElementById("free-reply-section");

  var autoReplySection = document.querySelector(".auto-reply-section");
  if (autoReplySection) {
    var autoReplyAccountId = autoReplySection.getAttribute("data-account-id") || accountId;
    var toggle = document.getElementById("auto-reply-toggle");
    var autoReplyMsg = document.getElementById("auto-reply-msg");
    if (autoReplyAccountId && toggle && autoReplyMsg) {
      toggle.addEventListener("change", function() {
        var enabled = toggle.checked;
        autoReplyMsg.textContent = "";
        autoReplyMsg.style.color = "";
        fetch("/businesses/" + encodeURIComponent(autoReplyAccountId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoReplyEnabled: enabled })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            autoReplyMsg.textContent = data.error;
            autoReplyMsg.style.color = "#c00";
            toggle.checked = !enabled;
          } else {
            autoReplyMsg.textContent = enabled ? "Auto-reply is on." : "Auto-reply is off.";
            autoReplyMsg.style.color = "#0a0";
          }
        })
        .catch(function() {
          autoReplyMsg.textContent = "Something went wrong.";
          autoReplyMsg.style.color = "#c00";
          toggle.checked = !enabled;
        });
      });
    }
  }

  if (!accountId) return;
  var btn = document.getElementById("free-reply-btn");
  var msg = document.getElementById("free-reply-msg");
  if (btn && msg) {
    btn.addEventListener("click", function() {
      btn.disabled = true;
      msg.textContent = "";
      msg.style.color = "";
      fetch("/free-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          msg.textContent = data.message || "Done! Check your Google listing.";
          msg.style.color = "#0a0";
        } else {
          msg.textContent = data.error || "Something went wrong.";
          msg.style.color = "#c00";
        }
      })
      .catch(function() {
        msg.textContent = "Something went wrong. Try again.";
        msg.style.color = "#c00";
      })
      .finally(function() { btn.disabled = false; });
    });
  }

  var contactSection = document.querySelector(".contact-section");
  if (contactSection) {
    var aid = contactSection.getAttribute("data-account-id");
    var contactInput = document.getElementById("contact-input");
    var contactSaveBtn = document.getElementById("contact-save-btn");
    var contactMsg = document.getElementById("contact-msg");
    if (aid && contactInput && contactSaveBtn && contactMsg) {
      contactSaveBtn.addEventListener("click", function() {
        var contact = contactInput.value.trim();
        contactSaveBtn.disabled = true;
        contactMsg.textContent = "";
        contactMsg.style.color = "";
        fetch("/businesses/" + encodeURIComponent(aid), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact: contact || "" })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            contactMsg.textContent = data.error;
            contactMsg.style.color = "#c00";
          } else {
            contactMsg.textContent = "Saved. We'll use this for 1–2 star replies.";
            contactMsg.style.color = "#0a0";
          }
        })
        .catch(function() {
          contactMsg.textContent = "Something went wrong.";
          contactMsg.style.color = "#c00";
        })
        .finally(function() { contactSaveBtn.disabled = false; });
      });
    }
  }

  // Sync UI from latest server state (handles back button / cached pages)
  fetch("/businesses/" + encodeURIComponent(accountId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data || data.error) return;
      var t = document.getElementById("auto-reply-toggle");
      if (t) {
        t.checked = !!data.autoReplyEnabled;
        t.disabled = !!data.trialEndedNoSubscription;
      }
      var ci = document.getElementById("contact-input");
      if (ci && data.contact !== undefined && data.contact !== null) ci.value = String(data.contact);
    })
    .catch(function() {});

  // Pro contacts: load count, preview/mapping, upload (only when business has Pro)
  var proSection = document.getElementById("pro-contacts-section");
  var isPro = proSection && proSection.getAttribute("data-is-pro") === "1";
  if (proSection && accountId && isPro) {
    var proCountEl = document.getElementById("pro-contacts-count");
    var proUploadBtn = document.getElementById("pro-upload-btn");
    var proCsvInput = document.getElementById("pro-csv-input");
    var proUploadMsg = document.getElementById("pro-upload-msg");
    var proMappingWrap = document.getElementById("pro-mapping-wrap");
    var proMapEmail = document.getElementById("pro-map-email");
    function showProCount(total, unsubscribed) {
      if (!proCountEl) return;
      if (total === 0) proCountEl.textContent = "No contacts yet. Upload a CSV to get started.";
      else proCountEl.textContent = total + " contact" + (total === 1 ? "" : "s") + (unsubscribed > 0 ? " (" + unsubscribed + " unsubscribed)" : "");
    }
    fetch("/pro/contacts?accountId=" + encodeURIComponent(accountId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) return;
        showProCount(data.total || 0, data.unsubscribed || 0);
      })
      .catch(function() {});
    function fillMappingSelects(headers) {
      if (!headers || !headers.length) return;
      var opt = function(val, label) { var o = document.createElement("option"); o.value = val || ""; o.textContent = label || val || "—"; return o; };
      if (proMapEmail) {
        proMapEmail.innerHTML = "";
        proMapEmail.appendChild(opt("", "— Select column —"));
        headers.forEach(function(h) { proMapEmail.appendChild(opt(h, h)); });
      }
      ["first_name", "birthday", "phone"].forEach(function(field) {
        var sel = document.getElementById("pro-map-" + field);
        if (!sel) return;
        var keepFirst = sel.options[0] && sel.options[0].value === "";
        sel.innerHTML = "";
        sel.appendChild(opt("", "— Don't use —"));
        headers.forEach(function(h) { sel.appendChild(opt(h, h)); });
      });
    }
    if (proCsvInput) {
      proCsvInput.addEventListener("change", function() {
        var file = proCsvInput.files && proCsvInput.files[0];
        if (!file) { if (proMappingWrap) proMappingWrap.style.display = "none"; return; }
        proUploadMsg.textContent = "";
        var fd = new FormData();
        fd.append("file", file);
        fd.append("accountId", accountId);
        fetch("/pro/contacts/preview", { method: "POST", body: fd })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.headers && data.headers.length) {
              fillMappingSelects(data.headers);
              if (proMappingWrap) proMappingWrap.style.display = "block";
            } else if (data.error) {
              proUploadMsg.textContent = data.error;
              proUploadMsg.style.color = "#c00";
            }
          })
          .catch(function() {});
      });
    }
    if (proUploadBtn && proCsvInput && proUploadMsg) {
      proUploadBtn.addEventListener("click", function() {
        var file = proCsvInput.files && proCsvInput.files[0];
        if (!file) {
          proUploadMsg.textContent = "Please choose a CSV file first.";
          proUploadMsg.style.color = "#c00";
          return;
        }
        var emailCol = proMapEmail && proMapEmail.value ? proMapEmail.value : null;
        if (proMappingWrap && proMappingWrap.style.display === "block" && !emailCol) {
          proUploadMsg.textContent = "Please select the email column.";
          proUploadMsg.style.color = "#c00";
          return;
        }
        proUploadBtn.disabled = true;
        proUploadMsg.textContent = "";
        proUploadMsg.style.color = "";
        var mapping = {};
        if (emailCol) mapping.email = emailCol;
        var selFirst = document.getElementById("pro-map-first_name");
        var selBirth = document.getElementById("pro-map-birthday");
        var selPhone = document.getElementById("pro-map-phone");
        if (selFirst && selFirst.value) mapping.first_name = selFirst.value;
        if (selBirth && selBirth.value) mapping.birthday = selBirth.value;
        if (selPhone && selPhone.value) mapping.phone = selPhone.value;
        var fd = new FormData();
        fd.append("file", file);
        fd.append("accountId", accountId);
        if (Object.keys(mapping).length) fd.append("mapping", JSON.stringify(mapping));
        fetch("/pro/contacts/upload", { method: "POST", body: fd })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.ok) {
              proUploadMsg.textContent = data.message || "Upload complete.";
              proUploadMsg.style.color = "#0a0";
              proCsvInput.value = "";
              if (proMappingWrap) proMappingWrap.style.display = "none";
              fetch("/pro/contacts?accountId=" + encodeURIComponent(accountId))
                .then(function(r2) { return r2.json(); })
                .then(function(c) { if (!c.error) showProCount(c.total || 0, c.unsubscribed || 0); })
                .catch(function() { showProCount(data.total || data.imported || 0, 0); });
            } else {
              proUploadMsg.textContent = data.error || "Upload failed.";
              proUploadMsg.style.color = "#c00";
            }
          })
          .catch(function() {
            proUploadMsg.textContent = "Upload failed. Try again.";
            proUploadMsg.style.color = "#c00";
          })
          .finally(function() { proUploadBtn.disabled = false; });
      });
    }
  }
})();
  `);
});
function escapeHtml(s) {
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return String(s).replace(/[&<>"]/g, (c) => d[c]);
}

app.get("/auth/google", async (req, res, next) => {
  try {
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (err) {
    req.log.error(err, "Failed to get Google auth URL");
    next(err);
  }
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }
    let accountId, accountName;
    try {
      const result = await handleOAuthCallback(code.toString());
      accountId = result.accountId;
      accountName = result.accountName;
    } catch (err) {
      if (err.message && err.message.includes("No Google Business accounts")) {
        return res.redirect("/no-business?" + new URLSearchParams({ reason: "no_account" }).toString());
      }
      throw err;
    }
    const locations = await listLocations(accountId);
    const firstLocation = locations[0];
    const locationId = firstLocation?.name
      ? firstLocation.name.split("/").pop()
      : null;
    const name = firstLocation?.title || accountName || null;
    if (!locationId && (!locations || locations.length === 0)) {
      return res.redirect("/no-business?" + new URLSearchParams({ reason: "no_location", accountId }).toString());
    }
    await upsertBusiness({
      accountId,
      locationId: locationId || "",
      name
    });
    const redirectName = name || "your business";
    res.redirect("/connected?name=" + encodeURIComponent(redirectName) + "&accountId=" + encodeURIComponent(accountId));
  } catch (err) {
    req.log.error(err, "OAuth callback failed");
    next(err);
  }
});

app.get("/me/google", async (req, res, next) => {
  try {
    const accountId = req.query.accountId || undefined;
    const status = await getTokenStatus(accountId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

app.post("/free-reply", async (req, res, next) => {
  try {
    const { accountId } = req.body || {};
    if (!accountId || typeof accountId !== "string") {
      return res.status(400).json({ error: "accountId is required" });
    }
    const business = await getBusiness(accountId);
    if (!business) {
      return res.status(404).json({ error: "Business not found. Connect via the signup link first." });
    }
    if (business.freeReplyUsed) {
      return res.status(400).json({ error: "You've already used your one free reply." });
    }
    const { locationId, contact } = business;
    if (!locationId) {
      return res.status(400).json({ error: "No location linked. Reconnect via the signup link." });
    }
    const reviews = await listReviews(accountId, locationId);
    const unreplied = reviews.find((r) => !r.reviewReply || !r.reviewReply.comment);
    if (!unreplied) {
      return res.status(400).json({ error: "You have no unreplied reviews right now. When you get one, come back and we'll reply for free." });
    }
    const reviewId = unreplied.reviewId || unreplied.name?.split("/").pop();
    if (!reviewId) {
      return res.status(500).json({ error: "Could not get review id" });
    }
    const comment = await getReplyText(unreplied, {
      contact,
      businessName: business.name || "our business"
    });
    await replyToReview(accountId, locationId, reviewId, comment);
    await addRepliedReviewId(accountId, locationId, reviewId);
    await upsertBusiness({ ...business, freeReplyUsed: true });
    return res.json({ ok: true, message: "We replied to your latest review. Check your Google listing." });
  } catch (err) {
    req.log.error(err, "Free reply failed");
    next(err);
  }
});

app.get("/businesses", async (req, res, next) => {
  try {
    const list = await getAllBusinesses();
    const businesses = Object.values(list);
    res.json(businesses);
  } catch (err) {
    next(err);
  }
});

app.get("/businesses/:accountId", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const business = await getBusiness(accountId);
    if (!business) {
      return res.status(404).json({ error: "Business not found. Connect via /auth/google first." });
    }
    const trialEnded =
      business.trialEndsAt && new Date(business.trialEndsAt) < new Date();
    const trialEndedNoSubscription = trialEnded && !business.subscribedAt;
    res.json({ ...business, trialEndedNoSubscription: !!trialEndedNoSubscription });
  } catch (err) {
    next(err);
  }
});

app.patch("/businesses/:accountId", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const existing = await getBusiness(accountId);
    if (!existing) {
      return res.status(404).json({ error: "Business not found. Connect via /auth/google first." });
    }
    const { autoReplyEnabled, contact, intervalMinutes } = req.body || {};
    if (autoReplyEnabled === true) {
      const trialEnded =
        existing.trialEndsAt && new Date(existing.trialEndsAt) < new Date();
      if (trialEnded && !existing.subscribedAt) {
        return res.status(403).json({
          error: "Trial ended. Subscribe to re-enable auto-reply.",
          code: "TRIAL_ENDED"
        });
      }
    }
    await upsertBusiness({
      ...existing,
      ...(typeof autoReplyEnabled === "boolean" && { autoReplyEnabled }),
      ...(contact !== undefined && { contact: String(contact) }),
      ...(intervalMinutes !== undefined && { intervalMinutes: Number(intervalMinutes) })
    });
    const updated = await getBusiness(accountId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- Replyr Pro: customer list (CSV upload) ---

app.get("/pro/contacts", async (req, res, next) => {
  try {
    const accountId = (req.query.accountId || "").trim();
    if (!accountId) {
      return res.status(400).json({ error: "accountId is required" });
    }
    const business = await getBusiness(accountId);
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }
    if (!business.isPro) {
      return res.status(403).json({ error: "Replyr Pro required. Upgrade at the Subscribe page." });
    }
    const { total, unsubscribed } = await getProContactsCount(accountId);
    res.json({ total, unsubscribed });
  } catch (err) {
    next(err);
  }
});

app.post("/pro/contacts/preview", proUpload.single("file"), async (req, res, next) => {
  try {
    const accountId = (req.body?.accountId ?? req.query?.accountId ?? "").trim();
    if (accountId) {
      const business = await getBusiness(accountId);
      if (!business?.isPro) {
        return res.status(403).json({ error: "Replyr Pro required to use customer list." });
      }
    }
    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const parsed = parseProCsv(file.buffer);
    res.json({ headers: parsed.headers || [], error: parsed.error || null });
  } catch (err) {
    next(err);
  }
});

app.post("/pro/contacts/upload", proUpload.single("file"), async (req, res, next) => {
  try {
    const accountId = (req.body?.accountId ?? req.query?.accountId ?? "").trim();
    if (!accountId) {
      return res.status(400).json({ error: "accountId is required" });
    }
    const business = await getBusiness(accountId);
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }
    if (!business.isPro) {
      return res.status(403).json({ error: "Replyr Pro required. Upgrade at the Subscribe page." });
    }
    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: "No file uploaded. Choose a CSV file." });
    }
    const mapping = req.body?.mapping ? (typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping) : null;
    const parsed = parseProCsv(file.buffer, { mapping });
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    await replaceProContacts(accountId, parsed.rows);
    res.json({
      ok: true,
      imported: parsed.rows.length,
      total: parsed.rows.length,
      message: `Uploaded ${parsed.rows.length} contact${parsed.rows.length === 1 ? "" : "s"}. Uploading replaces your current list.`
    });
  } catch (err) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large (max 5MB)" });
    }
    next(err);
  }
});

// --- Pro campaign API (require isPro and DB) ---
app.get("/pro/birthday-settings", async (req, res, next) => {
  try {
    const accountId = (req.query.accountId || "").trim();
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const settings = await db.getProBirthdaySettings(accountId);
    res.json(settings || { enabled: false, messageText: "", offerText: "", updatedAt: null });
  } catch (err) {
    next(err);
  }
});

app.patch("/pro/birthday-settings", async (req, res, next) => {
  try {
    const { accountId, enabled, messageText, offerText } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const updated = await db.setProBirthdaySettings(accountId, { enabled, messageText, offerText });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.get("/pro/events", (req, res) => {
  const events = getUpcomingEvents(90);
  res.json(events);
});

app.get("/pro/events/:key/:year", async (req, res, next) => {
  try {
    const accountId = (req.query.accountId || "").trim();
    const { key, year } = req.params;
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const campaign = await db.getProEventCampaign(accountId, key, parseInt(year, 10));
    res.json(campaign || { status: "pending", messageText: "", offerText: "", confirmedAt: null, sentAt: null });
  } catch (err) {
    next(err);
  }
});

app.patch("/pro/events/:key/:year", async (req, res, next) => {
  try {
    const accountId = (req.body?.accountId || req.query.accountId || "").trim();
    const { key, year } = req.params;
    const { status, messageText, offerText } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const eventYear = parseInt(year, 10);
    await db.upsertProEventCampaign(accountId, key, eventYear, {
      status: status || "pending",
      messageText,
      offerText,
      confirmedAt: status === "confirmed" ? new Date().toISOString() : null
    });
    const updated = await db.getProEventCampaign(accountId, key, eventYear);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.post("/pro/one-off", async (req, res, next) => {
  try {
    const { accountId, sendDate, subject, body } = req.body || {};
    if (!accountId || !sendDate || !subject) return res.status(400).json({ error: "accountId, sendDate, subject required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const campaign = await db.createProOneOffCampaign(accountId, sendDate, subject, body || "");
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

app.post("/pro/generate-message", async (req, res, next) => {
  try {
    const { accountId, type, eventName } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    const messageText = await generateCampaignMessageWithClaude({
      type: type || "birthday",
      businessName: business?.name || "Our business",
      eventName
    });
    res.json({ messageText });
  } catch (err) {
    next(err);
  }
});

// Pro campaigns dashboard (birthday settings, event opt-in, one-off)
app.get("/pro", async (req, res, next) => {
  try {
    const accountId = (req.query.accountId || "").trim();
    if (!accountId) {
      res.redirect("/subscribe");
      return;
    }
    const business = await getBusiness(accountId);
    if (!business?.isPro) {
      res.redirect("/subscribe?accountId=" + encodeURIComponent(accountId));
      return;
    }
    if (!db.useDb()) {
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.send(`
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Replyr Pro</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:2rem auto;padding:1.5rem;">
  <h1>Campaigns</h1>
  <p>Database is required for campaigns. Use a PostgreSQL connection in production.</p>
  <p><a href="/connected?accountId=${encodeURIComponent(accountId)}">← Back to Connected</a></p>
</body></html>`);
    }
    const birthday = await db.getProBirthdaySettings(accountId);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replyr Pro – Campaigns</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 640px; margin-left: auto; margin-right: auto; background: #f5f5f5; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
  .card { background: #fff; padding: 1.25rem; border-radius: 10px; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  label { display: block; margin-top: 0.5rem; font-weight: 500; }
  input[type="text"], input[type="date"], textarea { width: 100%; padding: 0.5rem; margin-top: 0.25rem; border: 1px solid #ddd; border-radius: 6px; }
  textarea { min-height: 80px; }
  button, .btn { padding: 0.5rem 1rem; background: #2160F3; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.95rem; }
  button.secondary { background: #666; }
  .msg { margin-top: 0.5rem; font-size: 0.9rem; }
  .compliance { font-size: 0.85rem; color: #666; margin-bottom: 1rem; }
  .event-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
  .event-row span { flex: 1; }
</style>
</head>
<body>
  <div id="pro-app" data-account-id="${escapeHtml(accountId)}">
    <h1>Replyr Pro – Campaigns</h1>
    <p class="compliance">By uploading and sending you confirm you have permission to email those contacts. <a href="/compliance">Compliance</a>.</p>
    <p><a href="/connected?accountId=${encodeURIComponent(accountId)}">← Back to Connected</a></p>

    <div class="card">
      <h2>Birthday messages</h2>
      <p>One message and offer used for all birthday emails. Use {{first_name}} and {{offer}} in the message.</p>
      <label><input type="checkbox" id="birthday-enabled" ${birthday?.enabled ? "checked" : ""}> Enable birthday emails</label>
      <label>Message <textarea id="birthday-message" placeholder="Happy birthday, {{first_name}}! As a thank you, {{offer}}">${escapeHtml(birthday?.messageText || "")}</textarea></label>
      <button type="button" id="birthday-generate" class="secondary">Generate with Replyr</button>
      <label>Offer (e.g. 20% off next visit) <input type="text" id="birthday-offer" value="${escapeHtml(birthday?.offerText || "")}" placeholder="20% off your next service"></label>
      <button type="button" id="birthday-save">Save</button>
      <span id="birthday-msg" class="msg"></span>
    </div>

    <div class="card">
      <h2>Upcoming events</h2>
      <p>Opt in per event (~2 weeks before send). Set message and offer, then Confirm. Skip if you don't want to send.</p>
      <div id="events-list"></div>
    </div>

    <div class="card">
      <h2>One-off promo</h2>
      <p>Schedule a single campaign for a date. Use {{first_name}} in the body.</p>
      <label>Send date <input type="date" id="oneoff-date"></label>
      <label>Subject <input type="text" id="oneoff-subject" placeholder="Subject line"></label>
      <label>Body <textarea id="oneoff-body" placeholder="Email body..."></textarea></label>
      <button type="button" id="oneoff-schedule">Schedule</button>
      <span id="oneoff-msg" class="msg"></span>
    </div>
  </div>
  <script src="/pro.js"></script>
</body></html>`);
  } catch (err) {
    next(err);
  }
});

app.get("/pro.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.send(`
(function() {
  var app = document.getElementById("pro-app");
  if (!app) return;
  var accountId = (app.getAttribute("data-account-id") || "").trim();
  if (!accountId) return;

  function loadEvents() {
    fetch("/pro/events").then(function(r) { return r.json(); }).then(function(events) {
      var el = document.getElementById("events-list");
      if (!el) return;
      el.innerHTML = events.slice(0, 14).map(function(ev) {
        return '<div class="event-row" data-key="' + ev.key + '" data-year="' + ev.sendDate.slice(0,4) + '">' +
          '<span><strong>' + ev.name + '</strong> – send ' + ev.sendDate + '</span>' +
          '<button type="button" class="event-confirm" data-key="' + ev.key + '" data-year="' + ev.sendDate.slice(0,4) + '">Confirm</button>' +
          '<button type="button" class="secondary event-skip" data-key="' + ev.key + '" data-year="' + ev.sendDate.slice(0,4) + '">Skip</button>' +
          '</div>';
      }).join("");
      el.querySelectorAll(".event-confirm").forEach(function(btn) {
        btn.onclick = function() {
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          var msg = prompt("Message (optional; use {{offer}} for the offer):") || "";
          var offer = prompt("Offer (e.g. 20% off):") || "";
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: accountId, status: "confirmed", messageText: msg, offerText: offer })
          }).then(function(r) { return r.json(); }).then(function() { btn.textContent = "Confirmed"; btn.disabled = true; }).catch(function() { alert("Failed"); });
        };
      });
      el.querySelectorAll(".event-skip").forEach(function(btn) {
        btn.onclick = function() {
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: accountId, status: "skipped" })
          }).then(function(r) { return r.json(); }).then(function() { btn.textContent = "Skipped"; btn.disabled = true; });
        };
      });
    });
  }
  loadEvents();

  var birthdayGenerate = document.getElementById("birthday-generate");
  if (birthdayGenerate) {
    birthdayGenerate.onclick = function() {
      birthdayGenerate.disabled = true;
      fetch("/pro/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "birthday" })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var ta = document.getElementById("birthday-message");
        if (ta && data.messageText) ta.value = data.messageText;
      }).catch(function() { alert("Generate failed"); }).finally(function() { birthdayGenerate.disabled = false; });
    };
  }
  var birthdaySave = document.getElementById("birthday-save");
  if (birthdaySave) {
    birthdaySave.onclick = function() {
      var enabled = document.getElementById("birthday-enabled").checked;
      var message = document.getElementById("birthday-message").value;
      var offer = document.getElementById("birthday-offer").value;
      birthdaySave.disabled = true;
      fetch("/pro/birthday-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, enabled: enabled, messageText: message, offerText: offer })
      }).then(function(r) { return r.json(); }).then(function() {
        document.getElementById("birthday-msg").textContent = "Saved.";
        document.getElementById("birthday-msg").style.color = "#2e7d32";
      }).catch(function() {
        document.getElementById("birthday-msg").textContent = "Save failed.";
        document.getElementById("birthday-msg").style.color = "#c00";
      }).finally(function() { birthdaySave.disabled = false; });
    };
  }

  var oneoffSchedule = document.getElementById("oneoff-schedule");
  if (oneoffSchedule) {
    oneoffSchedule.onclick = function() {
      var date = document.getElementById("oneoff-date").value;
      var subject = document.getElementById("oneoff-subject").value.trim();
      var body = document.getElementById("oneoff-body").value;
      if (!date || !subject) { alert("Date and subject required"); return; }
      oneoffSchedule.disabled = true;
      fetch("/pro/one-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, sendDate: date, subject: subject, body: body })
      }).then(function(r) { return r.json(); }).then(function() {
        document.getElementById("oneoff-msg").textContent = "Scheduled for " + date;
        document.getElementById("oneoff-msg").style.color = "#2e7d32";
        document.getElementById("oneoff-date").value = "";
        document.getElementById("oneoff-subject").value = "";
        document.getElementById("oneoff-body").value = "";
      }).catch(function() {
        document.getElementById("oneoff-msg").textContent = "Failed.";
        document.getElementById("oneoff-msg").style.color = "#c00";
      }).finally(function() { oneoffSchedule.disabled = false; });
    };
  }
})();
`);
});

// Pro: unsubscribe from campaign emails (signed token in link)
app.get("/pro/unsubscribe", async (req, res, next) => {
  try {
    const token = (req.query.token || "").trim();
    const decoded = verifyUnsubscribeToken(token);
    if (!decoded) {
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invalid link</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:2rem auto;padding:1.5rem;text-align:center;">
  <h1>Invalid or expired link</h1>
  <p>This unsubscribe link is invalid or has expired. If you still want to stop emails, contact the business that sent them.</p>
</body></html>`);
    }
    const { accountId, email } = decoded;
    await setProContactUnsubscribed(accountId, email);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:2rem auto;padding:1.5rem;text-align:center;">
  <h1>You're unsubscribed</h1>
  <p>You won't receive further campaign emails from this business via Replyr.</p>
</body></html>`);
  } catch (err) {
    next(err);
  }
});

// Compliance / acceptable use (linked from Pro UI and email footer)
app.get("/compliance", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replyr – Email compliance</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:2rem auto;padding:1.5rem;">
  <h1>Replyr – Email compliance</h1>
  <p>By uploading a customer list and sending campaigns through Replyr Pro, you confirm that you have permission to email those contacts (e.g. they opted in or have an existing relationship with your business).</p>
  <p>You must not use Replyr to send spam or to contacts who have not agreed to hear from you. Every campaign email includes an unsubscribe link; we process opt-outs and do not resend to unsubscribed addresses.</p>
  <p>We include a physical address in campaign footers where required (e.g. CAN-SPAM).</p>
  <p><a href="/">← Back to Replyr</a></p>
</body></html>`);
});

// Admin page: list businesses, edit contact and auto-reply
app.get("/admin", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Replyr – Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 1.5rem; background: #f5f5f5; }
    h1 { margin: 0 0 1rem; font-size: 1.25rem; color: #333; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; color: #555; font-size: 0.8rem; text-transform: uppercase; }
    tr:last-child td { border-bottom: none; }
    input[type="text"], input[type="number"] { width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.9rem; }
    input[type="checkbox"] { width: 1.1rem; height: 1.1rem; }
    button { padding: 0.5rem 1rem; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
    button:hover { background: #555; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .msg { margin-top: 0.5rem; font-size: 0.85rem; }
    .msg.ok { color: #0a0; }
    .msg.err { color: #c00; }
    .empty { color: #888; padding: 2rem; text-align: center; }
    .refresh { margin-bottom: 1rem; }
    .filter-row { margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
    .filter-row label { font-size: 0.9rem; color: #555; }
    .filter-row select { padding: 0.35rem 0.5rem; border: 1px solid #ddd; border-radius: 4px; font-size: 0.9rem; }
    .status-subscribed { color: #2e7d32; font-weight: 500; }
    .status-trial { color: #1565c0; }
    .status-expired { color: #c62828; }
  </style>
</head>
<body>
  <h1>Replyr – Admin</h1>
  <p class="refresh"><a href="/admin">Refresh</a> · <a href="/businesses">JSON</a></p>
  <div id="loading">Loading businesses…</div>
  <div id="content" style="display: none;">
    <div class="filter-row" id="filter-row" style="display: none;"><label for="status-filter">Status:</label><select id="status-filter"><option value="">All</option><option value="trial">Trial</option><option value="subscribed">Subscribed</option><option value="expired">Expired</option></select></div>
  </div>
  <script src="/admin.js"></script>
</body>
</html>
  `);
});

// Admin script (separate so CSP allows it)
app.get("/admin.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.send(`
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
function getStatus(b) {
  if (b.subscribedAt) return { status: "subscribed", label: "Subscribed", className: "status-subscribed" };
  if (b.trialEndsAt && new Date(b.trialEndsAt) < new Date()) return { status: "expired", label: "Expired", className: "status-expired" };
  return { status: "trial", label: "Trial", className: "status-trial" };
}
function formatTrialEnd(trialEndsAt) {
  if (!trialEndsAt) return "—";
  try {
    const d = new Date(trialEndsAt);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch (_) { return "—"; }
}
async function load() {
  const loading = document.getElementById("loading");
  const content = document.getElementById("content");
  const filterRow = document.getElementById("filter-row");
  try {
    const r = await fetch("/businesses");
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) {
      content.innerHTML = "<p class=\\"empty\\">No businesses yet. Have them connect via the auth link.</p>";
    } else {
      const tableHtml = "<table><thead><tr><th>Name</th><th>Contact (for 1–2 star replies)</th><th>Trial ends</th><th>Status</th><th>Auto-reply</th><th>Interval (min)</th><th>Actions</th></tr></thead><tbody></tbody></table>";
      content.insertAdjacentHTML("beforeend", tableHtml);
      const table = content.querySelector("table");
      if (filterRow) { content.insertBefore(filterRow, table); filterRow.style.display = "flex"; }
      const tbody = content.querySelector("tbody");
      list.forEach(b => {
        const s = getStatus(b);
        const trialEndStr = formatTrialEnd(b.trialEndsAt);
        const tr = document.createElement("tr");
        tr.dataset.accountId = b.accountId;
        tr.dataset.locationId = b.locationId || "";
        tr.dataset.status = s.status;
        tr.innerHTML = "<td>" + escapeHtml(b.name || "—") + "</td>" +
          "<td><input type=\\"text\\" value=\\"" + escapeAttr(b.contact || "") + "\\" data-field=\\"contact\\"></td>" +
          "<td>" + escapeHtml(trialEndStr) + "</td>" +
          "<td><span class=\\"" + s.className + "\\">" + escapeHtml(s.label) + "</span></td>" +
          "<td><input type=\\"checkbox\\" " + (b.autoReplyEnabled ? "checked" : "") + " data-field=\\"autoReplyEnabled\\"></td>" +
          "<td><input type=\\"number\\" min=\\"1\\" value=\\""
          + (b.intervalMinutes ?? 30)
          + "\\" data-field=\\"intervalMinutes\\" style=\\"width:4rem\\"></td>" +
          "<td><button type=\\"button\\" data-save>Save</button> <button type=\\"button\\" data-run-now title=\\"Run Claude auto-reply now\\">Run now</button><span class=\\"msg\\" data-msg></span></td>";
        tbody.appendChild(tr);
      });
      content.querySelectorAll("[data-save]").forEach(btn => { btn.addEventListener("click", saveRow); });
      content.querySelectorAll("[data-run-now]").forEach(btn => { btn.addEventListener("click", runNowRow); });
      var statusFilter = document.getElementById("status-filter");
      if (statusFilter) {
        statusFilter.addEventListener("change", function() {
          var val = statusFilter.value;
          content.querySelectorAll("tbody tr").forEach(function(tr) {
            tr.style.display = (!val || tr.dataset.status === val) ? "" : "none";
          });
        });
      }
    }
  } catch (e) {
    content.innerHTML = "<p class=\\"msg err\\">Failed to load: " + escapeHtml(e.message) + "</p>";
  }
  loading.style.display = "none";
  content.style.display = "block";
}
async function saveRow(e) {
  const btn = e.target;
  const tr = btn.closest("tr");
  const accountId = tr.dataset.accountId;
  const contact = tr.querySelector("[data-field=contact]").value.trim();
  const autoReplyEnabled = tr.querySelector("[data-field=autoReplyEnabled]").checked;
  const intervalMinutes = parseInt(tr.querySelector("[data-field=intervalMinutes]").value, 10) || 30;
  const msgEl = tr.querySelector("[data-msg]");
  msgEl.textContent = "";
  msgEl.className = "msg";
  btn.disabled = true;
  try {
    const r = await fetch("/businesses/" + encodeURIComponent(accountId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, autoReplyEnabled, intervalMinutes })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    msgEl.textContent = "Saved.";
    msgEl.className = "msg ok";
  } catch (err) {
    msgEl.textContent = err.message || "Error";
    msgEl.className = "msg err";
  }
  btn.disabled = false;
}
async function runNowRow(e) {
  const btn = e.target;
  const tr = btn.closest("tr");
  const accountId = tr.dataset.accountId;
  const locationId = tr.dataset.locationId;
  const msgEl = tr.querySelector("[data-msg]");
  msgEl.textContent = "";
  msgEl.className = "msg";
  if (!locationId) {
    msgEl.textContent = "No location";
    msgEl.className = "msg err";
    return;
  }
  btn.disabled = true;
  try {
    const r = await fetch("/auto/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, locationId })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const res = data.result || {};
    var txt = "Done. Attempted: " + (res.attempted || 0) + ", succeeded: " + (res.succeeded || 0) + ", failed: " + (res.failed || 0);
    if ((res.failed || 0) > 0 && Array.isArray(res.details)) {
      var errDetail = res.details.find(function(d) { return d.status === "error" && d.message; });
      if (errDetail) txt += " — " + errDetail.message;
    }
    msgEl.textContent = txt;
    msgEl.className = (res.failed || 0) > 0 ? "msg err" : "msg ok";
  } catch (err) {
    msgEl.textContent = err.message || "Error";
    msgEl.className = "msg err";
  }
  btn.disabled = false;
}
load();
  `);
});

app.post("/google/reviews/:accountId/:locationId/:reviewId/reply", async (req, res, next) => {
  try {
    const { accountId, locationId, reviewId } = req.params;
    const { comment } = req.body || {};
    if (!comment || typeof comment !== "string" || comment.trim().length === 0) {
      return res.status(400).json({ error: "comment is required" });
    }
    const result = await replyToReview(accountId, locationId, reviewId, comment.trim());
    res.json({ ok: true, result });
  } catch (err) {
    req.log.error(err, "Failed to reply to review");
    next(err);
  }
});

app.get("/google/accounts", async (req, res, next) => {
  try {
    const accounts = await listAccounts();
    res.json(accounts);
  } catch (err) {
    req.log.error(err, "Failed to list accounts");
    next(err);
  }
});

app.get("/google/accounts/:accountId/locations", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const locations = await listLocations(accountId);
    res.json(locations);
  } catch (err) {
    req.log.error(err, "Failed to list locations");
    next(err);
  }
});

app.get("/google/accounts/:accountId/locations/:locationId/reviews", async (req, res, next) => {
  try {
    const { accountId, locationId } = req.params;
    const reviews = await listReviews(accountId, locationId);
    res.json(reviews);
  } catch (err) {
    req.log.error(err, "Failed to list reviews");
    next(err);
  }
});

// Manual trigger for auto-replies (body: accountId, locationId — or env fallback)
app.post("/auto/process", async (req, res, next) => {
  try {
    const { accountId, locationId } = req.body || {};
    const a = accountId || process.env.AUTO_REPLY_ACCOUNT_ID;
    const l = locationId || process.env.AUTO_REPLY_LOCATION_ID;
    if (!a || !l) {
      return res.status(400).json({ error: "accountId and locationId required (body or env)" });
    }
    const business = await getBusiness(a);
    const result = await processPendingReviews(a, l, {
      contact: business?.contact,
      businessName: business?.name || "our business",
      logger: req.log
    });
    res.json({ ok: true, result });
  } catch (err) {
    req.log.error(err, "Auto process failed");
    next(err);
  }
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

start().catch((err) => {
  logger.fatal(err, "Startup failed");
  process.exit(1);
});
