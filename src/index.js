import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import * as db from "./db.js";
import { getAuthUrl, handleOAuthCallback, getTokenStatus, replyToReview, listAccounts, listLocations, listReviews } from "./google.js";
import { processPendingReviews, startScheduler, getReplyText, addRepliedReviewId } from "./auto.js";
import { getAllBusinesses, getBusiness, upsertBusiness, getAccountIdByStripeCustomerId } from "./businesses.js";
import { replaceProContacts, getProContactsCount, setProContactUnsubscribed } from "./proContacts.js";
import { parseProCsv, validateFile } from "./csvPro.js";
import { verifyUnsubscribeToken } from "./campaignEmail.js";
import { generateCampaignMessageWithClaude, generateOneOffWithClaude } from "./ai.js";
import {
  getUpcomingEvents,
  getEventSendDate,
  getSendDateForEvent,
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
    for (const { accountId, eventKey, eventYear, sendDaysBefore } of eventDue) {
      const eventDate = getEventSendDate(eventKey, eventYear);
      const sendDate = getSendDateForEvent(eventDate, sendDaysBefore);
      if (sendDate !== today) continue;
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

// Signup/landing page – connect with Google (dark theme, blue accent; see src/views/signup.html)
function signupPageHtml() {
  return fs.readFileSync(path.join(__dirname, "views", "signup.html"), "utf8");
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
    const trialBarPct = trialEndsAt != null && trialDaysLeft != null && trialDaysLeft >= 0 ? Math.min(100, (trialDaysLeft / 30) * 100) : 0;
    const trialCard =
      trialEndsAt != null
        ? `<div class="card trial-card">
  <div class="card-label">Your 30-day free trial</div>
  ${trialEndedNoSubscription ? `<div class="trial-days" style="color:var(--muted);font-size:24px">Trial ended</div><div class="trial-ends">Subscribe to re-enable auto-reply.</div><div class="upgrade-link"><a href="/subscribe${accountId ? "?accountId=" + encodeURIComponent(accountId) : ""}">View plans →</a></div>` : `<div class="trial-days">${trialDaysLeft != null && trialDaysLeft >= 0 ? escapeHtml(String(trialDaysLeft)) : "0"} <span>days left</span></div>
  <div class="trial-ends">${trialDaysLeft != null && trialDaysLeft >= 0 ? "Ends " : "Ended "}${escapeHtml(trialEndDateFormatted)}</div>
  ${trialEndingSoon ? `<div class="trial-ends" style="color:var(--accent);margin-bottom:8px">Ends in ${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"}. <a href="/subscribe${accountId ? "?accountId=" + encodeURIComponent(accountId) : ""}" style="color:inherit;font-weight:600">Subscribe</a></div>` : ""}
  <div class="trial-bar"><div class="trial-bar-fill" style="width:${trialBarPct}%"></div></div>
  <div class="upgrade-link">Upgrade to keep auto-reply after your trial. <a href="/subscribe${accountId ? "?accountId=" + encodeURIComponent(accountId) : ""}">View plans →</a></div>
</div>`}`
        : "";
    const autoReplyCard = accountId
      ? `<div class="card auto-reply-section" data-account-id="${escapeHtml(accountId)}" data-trial-ended="${trialEndedNoSubscription ? "1" : "0"}">
  <div class="card-title">Auto-reply</div>
  <div class="toggle-row">
    <label class="toggle">
      <input type="checkbox" id="auto-reply-toggle" ${currentAutoReply ? "checked" : ""} ${trialEndedNoSubscription ? "disabled" : ""}>
      <div class="toggle-track"></div>
    </label>
    <span class="toggle-label">Reply to new Google reviews automatically</span>
  </div>
  ${trialEndedNoSubscription ? '<p class="trial-gate-msg" style="font-size:13px;color:var(--danger);margin-top:12px">Subscribe to re-enable auto-reply.</p>' : ""}
  <p id="auto-reply-msg" class="connected-msg" aria-live="polite"></p>
</div>`
      : "";
    const tryItCard = accountId
      ? `<div class="card" id="free-reply-section" data-account-id="${escapeHtml(accountId)}">
  <div class="card-title">Try it now</div>
  <div class="card-desc">We'll reply to your latest unreplied review once, free. You'll see it on your Google listing.</div>
  <button type="button" id="free-reply-btn" class="btn btn-primary"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>Send my 1 free reply</button>
  <p id="free-reply-msg" class="connected-msg" aria-live="polite"></p>
</div>`
      : "";
    const contactCard = accountId
      ? `<div class="card contact-section" data-account-id="${escapeHtml(accountId)}">
  <div class="card-title">Contact for 1–2 star replies</div>
  <div class="card-desc">If a customer leaves a low rating, we'll suggest they reach out. Add your phone or email so the reply uses your real contact.</div>
  <div class="contact-input-row">
    <input type="text" id="contact-input" value="${escapeHtml(currentContact)}" placeholder="Phone or email">
    <button type="button" id="contact-save-btn" class="btn-save">Save</button>
  </div>
  <p id="contact-msg" class="connected-msg" aria-live="polite"></p>
</div>`
      : "";
    const proCard = accountId
      ? `<div class="card card-full" id="pro-contacts-section" data-account-id="${escapeHtml(accountId)}" data-is-pro="${isPro ? "1" : "0"}">
  <div class="pro-card-header">
    <div><div class="card-title" style="margin-bottom:4px">Replyr Pro – Customer list</div><div class="card-desc" style="margin-bottom:0">Upload a CSV of customers for future promos and birthday messages.</div></div>
    <span class="contacts-badge" id="pro-contacts-count">0 contacts</span>
  </div>
  ${isPro
    ? `<div class="field-specs"><strong>Required:</strong> <code>email</code> &nbsp;·&nbsp; <strong>Recommended:</strong> <code>first_name</code> or <code>name</code>, <code>birthday</code> or <code>birth_date</code> (YYYY-MM-DD or MM/DD) &nbsp;·&nbsp; <strong>Optional:</strong> <code>phone</code><br><span style="margin-top:6px;display:inline-block">Max 5MB. Uploading replaces your current list. <a href="/compliance" style="color:var(--accent2);text-decoration:none">Compliance →</a></span></div>
  <label class="csv-zone"><input type="file" id="pro-csv-input" accept=".csv,text/csv,text/plain" aria-label="Choose CSV"> <div class="csv-icon">📂</div><div class="csv-zone-title">Drop your CSV here or click to browse</div><div class="csv-zone-sub">No file chosen · Max 5MB</div></label>
  <div id="pro-mapping-wrap" class="pro-mapping-wrap" style="display:none;"><p class="pro-mapping-label">Map your columns:</p><div class="pro-mapping-row"><label>Email *</label><select id="pro-map-email" data-field="email"></select></div><div class="pro-mapping-row"><label>First name</label><select id="pro-map-first_name" data-field="first_name"><option value="">— Don't use —</option></select></div><div class="pro-mapping-row"><label>Birthday</label><select id="pro-map-birthday" data-field="birthday"><option value="">— Don't use —</option></select></div><div class="pro-mapping-row"><label>Phone</label><select id="pro-map-phone" data-field="phone"><option value="">— Don't use —</option></select></div></div>
  <button type="button" id="pro-upload-btn" class="btn btn-ghost" style="max-width:180px"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v9M4 8l4 4 4-4"/><path d="M2 14h12"/></svg>Upload CSV</button>
  <p id="pro-upload-msg" class="connected-msg" aria-live="polite"></p>
  <div style="text-align:center"><a href="/pro?accountId=${encodeURIComponent(accountId)}" class="manage-link">🗓 Manage campaigns <span style="color:var(--muted);font-weight:400">(birthday, events, one-off)</span> →</a></div>`
    : `<div class="card-desc" style="margin-bottom:12px">Replyr Pro turns your customer list into automated, personal outreach. This is included in <strong>Replyr Pro</strong>.</div>
  <ul class="pro-benefits"><li><strong>Customer database</strong> — Upload a CSV (email, name, birthday, phone). We store it securely per business.</li><li><strong>Birthday messages</strong> — We automatically email customers on their birthday. Add a coupon or any offer you choose.</li><li><strong>Holiday & event campaigns</strong> — Mothers Day, Fathers Day, and more. You pick the discount or message.</li><li><strong>Your voice or ours</strong> — Curate the message yourself or let Replyr write it.</li><li><strong>Sent on your behalf</strong> — Emails go out with your business name; replies go to your contact email.</li></ul>
  <p class="card-desc" style="margin-bottom:8px">By uploading and sending you confirm you have permission to email those contacts. <a href="/compliance" style="color:var(--accent2)">Compliance</a>.</p>
  <p><a href="/subscribe?accountId=${encodeURIComponent(accountId)}" class="manage-link">Upgrade to Pro →</a> to unlock the customer list and automated campaigns.</p>`}
</div>`
      : "";
    const freeReplySection = accountId ? `<div class="grid">${trialCard}${autoReplyCard}</div><div class="grid">${tryItCard}${contactCard}</div>${proCard}` : "";
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Replyr – Connected</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #7a7880; --danger: #ff6b6b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; overflow-x: hidden; }
  body::before { content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%); width: 800px; height: 500px; background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%); pointer-events: none; z-index: 0; }
  .wrapper { width: 100%; max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; position: relative; z-index: 1; }
  .hero-card { background: var(--surface); border: 1px solid var(--border); border-radius: 24px; padding: 40px 32px; text-align: center; margin-bottom: 20px; animation: fadeUp 0.4s ease both; position: relative; overflow: hidden; }
  .hero-card::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent2), var(--accent), transparent); opacity: 0.5; }
  .logo-mark { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 15px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
  .logo-icon { width: 28px; height: 28px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .hero-title { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 400; color: var(--text); margin-bottom: 10px; }
  .hero-title span { color: var(--accent); font-style: italic; }
  .hero-desc { color: var(--muted); font-size: 14px; line-height: 1.6; max-width: 380px; margin: 0 auto 6px; }
  .hero-desc a { color: var(--accent2); text-decoration: none; }
  .hero-desc a:hover { text-decoration: underline; }
  .connected-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(74,158,255,0.12); border: 1px solid rgba(74,158,255,0.25); border-radius: 20px; padding: 5px 12px; font-size: 12px; font-weight: 600; color: var(--accent); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 20px; }
  .connected-badge::before { content: ''; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 540px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 24px; animation: fadeUp 0.4s ease both; transition: border-color 0.2s; min-width: 0; }
  .card:hover { border-color: rgba(255,255,255,0.12); }
  .card:nth-child(1) { animation-delay: 0.05s; } .card:nth-child(2) { animation-delay: 0.10s; } .card:nth-child(3) { animation-delay: 0.15s; } .card:nth-child(4) { animation-delay: 0.20s; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .trial-card { background: linear-gradient(135deg, rgba(124,106,247,0.12), rgba(74,158,255,0.08)); border-color: rgba(124,106,247,0.25); }
  .card-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 12px; }
  .trial-days { font-family: 'Fraunces', serif; font-size: 48px; font-weight: 300; color: var(--accent); line-height: 1; margin-bottom: 4px; }
  .trial-days span { font-size: 18px; color: var(--muted); font-family: 'DM Sans', sans-serif; font-weight: 400; }
  .trial-ends { font-size: 13px; color: var(--muted); margin-bottom: 16px; }
  .trial-bar { height: 4px; background: rgba(255,255,255,0.08); border-radius: 4px; margin-bottom: 16px; overflow: hidden; }
  .trial-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent2), var(--accent)); border-radius: 4px; transition: width 0.3s; }
  .upgrade-link { font-size: 13px; color: var(--muted); }
  .upgrade-link a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .upgrade-link a:hover { text-decoration: underline; }
  .card-title { font-family: 'Fraunces', serif; font-size: 17px; font-weight: 400; color: var(--text); margin-bottom: 16px; }
  .card-desc { font-size: 13px; color: var(--muted); line-height: 1.6; margin-bottom: 18px; }
  .toggle-row { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: var(--surface2); border-radius: 12px; border: 1px solid var(--border); }
  .toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; cursor: pointer; }
  .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
  .toggle-track { position: absolute; inset: 0; background: #333; border-radius: 20px; transition: 0.3s; }
  .toggle-track::before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: var(--text); border-radius: 50%; transition: 0.3s; }
  .toggle input:not(:checked) + .toggle-track { background: #333; }
  .toggle input:checked + .toggle-track { background: var(--accent); }
  .toggle input:checked + .toggle-track::before { background: var(--bg); transform: translateX(16px); }
  .toggle input:disabled + .toggle-track { opacity: 0.6; cursor: not-allowed; }
  .toggle-label { font-size: 13px; color: var(--text); font-weight: 500; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: none; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; padding: 11px 20px; transition: all 0.2s; letter-spacing: 0.01em; width: 100%; }
  .btn-primary { background: var(--accent); color: #0f0f11; }
  .btn-primary:hover:not(:disabled) { background: #6bafff; transform: translateY(-1px); box-shadow: 0 4px 20px rgba(74,158,255,0.25); }
  .btn-primary:disabled { opacity: 0.7; cursor: not-allowed; }
  .btn-ghost { background: var(--surface2); color: var(--text); border: 1px solid var(--border); width: auto; }
  .btn-ghost:hover { background: rgba(124,106,247,0.15); border-color: rgba(124,106,247,0.4); }
  .contact-input-row { display: flex; gap: 8px; margin-top: 14px; }
  input[type="text"], input[type="tel"] { flex: 1; min-width: 0; background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; padding: 11px 14px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
  input:focus { border-color: rgba(74,158,255,0.4); box-shadow: 0 0 0 3px rgba(74,158,255,0.08); }
  .btn-save { background: var(--accent2); color: #fff; border: none; border-radius: 10px; font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; padding: 11px 18px; transition: all 0.2s; white-space: nowrap; }
  .btn-save:hover:not(:disabled) { background: #9084f9; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(124,106,247,0.3); }
  .btn-save:disabled { opacity: 0.7; cursor: not-allowed; }
  .card-full { animation-delay: 0.25s; min-width: 0; }
  .pro-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .contacts-badge { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); background: var(--surface2); padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); }
  .field-specs { background: var(--surface2); border-radius: 12px; padding: 14px 16px; font-size: 13px; color: var(--muted); line-height: 1.7; margin-bottom: 16px; }
  .field-specs strong { color: var(--text); }
  .field-specs code { background: rgba(255,255,255,0.07); border-radius: 4px; padding: 1px 6px; font-size: 12px; color: var(--accent); }
  .csv-zone { border: 1.5px dashed rgba(255,255,255,0.1); border-radius: 14px; padding: 24px; text-align: center; margin: 16px 0; cursor: pointer; transition: border-color 0.2s, background 0.2s; display: block; }
  .csv-zone:hover { border-color: rgba(74,158,255,0.35); background: rgba(74,158,255,0.04); }
  .csv-zone input[type="file"] { display: none; }
  .csv-icon { font-size: 28px; margin-bottom: 8px; }
  .csv-zone-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .csv-zone-sub { font-size: 12px; color: var(--muted); }
  .pro-mapping-wrap { margin-top: 12px; padding: 12px; background: var(--surface2); border-radius: 12px; border: 1px solid var(--border); font-size: 13px; }
  .pro-mapping-label { margin: 0 0 8px; color: var(--muted); }
  .pro-mapping-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .pro-mapping-row label { min-width: 80px; color: var(--text); }
  .pro-mapping-row select { flex: 1; max-width: 180px; padding: 6px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); }
  .empty-state { text-align: center; padding: 20px 0 4px; color: var(--muted); font-size: 13px; }
  .manage-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--accent2); font-size: 13px; font-weight: 500; text-decoration: none; transition: color 0.2s; }
  .manage-link:hover { color: #a099f7; }
  .stars-row { display: flex; gap: 2px; margin-bottom: 6px; }
  .star { color: #f59e0b; font-size: 13px; }
  .connected-msg { margin-top: 8px; font-size: 13px; min-height: 1.4em; }
  .connected-msg.ok { color: #6ee7a3; }
  .connected-msg.err { color: var(--danger); }
  .pro-benefits { margin: 12px 0; padding-left: 20px; font-size: 13px; color: var(--muted); line-height: 1.6; }
  .pro-benefits li { margin-bottom: 6px; }
  .thanks-msg { margin-bottom: 12px; padding: 10px 14px; background: rgba(74,158,255,0.12); border-radius: 10px; color: var(--accent); font-size: 14px; }
</style>
</head>
<body>
<div class="wrapper" ${accountId ? `data-account-id="${escapeHtml(accountId)}"` : ""}>
  <div class="hero-card">
    <div class="logo-mark"><div class="logo-icon">💬</div>Replyr</div>
    <div class="connected-badge">Connected</div>
    <h1 class="hero-title">You're <span>connected</span></h1>
    ${justSubscribed ? '<p class="thanks-msg">Thanks for subscribing. Auto-reply will continue after your trial.</p>' : ""}
    <p class="hero-desc">${escapeHtml(displayName)} is set up. We'll help you reply to Google reviews from here.</p>
    <p class="hero-desc" style="margin-top:6px">Come back anytime via <a href="/dashboard">Dashboard</a> (we'll have you sign in with Google again).</p>
    ${hasBillingPortal ? `<p class="hero-desc" style="margin-top:8px"><a href="${escapeHtml(billingPortalUrl)}" target="_blank" rel="noopener">Manage billing</a></p>` : ""}
    ${nextStepLine ? `<p class="hero-desc" style="margin-top:8px">${nextStepLine}</p>` : ""}
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
        autoReplyMsg.classList.remove("ok", "err");
        fetch("/businesses/" + encodeURIComponent(autoReplyAccountId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoReplyEnabled: enabled })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          autoReplyMsg.classList.remove("ok", "err");
          if (data.error) {
            autoReplyMsg.textContent = data.error;
            autoReplyMsg.classList.add("err");
            toggle.checked = !enabled;
          } else {
            autoReplyMsg.textContent = enabled ? "Auto-reply is on." : "Auto-reply is off.";
            autoReplyMsg.classList.add("ok");
          }
        })
        .catch(function() {
          autoReplyMsg.textContent = "Something went wrong.";
          autoReplyMsg.classList.remove("ok"); autoReplyMsg.classList.add("err");
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
      msg.classList.remove("ok", "err");
      fetch("/free-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId })
      })
      .then(function(r) { return r.json(); })
        .then(function(data) {
        msg.classList.remove("ok", "err");
        if (data.ok) {
          msg.textContent = data.message || "Done! Check your Google listing.";
          msg.classList.add("ok");
        } else {
          msg.textContent = data.error || "Something went wrong.";
          msg.classList.add("err");
        }
      })
      .catch(function() {
        msg.textContent = "Something went wrong. Try again.";
        msg.classList.remove("ok"); msg.classList.add("err");
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
        contactMsg.classList.remove("ok", "err");
        fetch("/businesses/" + encodeURIComponent(aid), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact: contact || "" })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            contactMsg.classList.remove("ok", "err");
            if (data.error) {
              contactMsg.textContent = data.error;
              contactMsg.classList.add("err");
            } else {
              contactMsg.textContent = "Saved. We'll use this for 1–2 star replies.";
              contactMsg.classList.add("ok");
            }
          })
        .catch(function() {
          contactMsg.textContent = "Something went wrong.";
          contactMsg.classList.remove("ok"); contactMsg.classList.add("err");
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
              proUploadMsg.classList.remove("ok"); proUploadMsg.classList.add("err");
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
          proUploadMsg.classList.remove("ok"); proUploadMsg.classList.add("err");
          return;
        }
        var emailCol = proMapEmail && proMapEmail.value ? proMapEmail.value : null;
        if (proMappingWrap && proMappingWrap.style.display === "block" && !emailCol) {
          proUploadMsg.textContent = "Please select the email column.";
          proUploadMsg.classList.remove("ok"); proUploadMsg.classList.add("err");
          return;
        }
        proUploadBtn.disabled = true;
        proUploadMsg.textContent = "";
        proUploadMsg.classList.remove("ok", "err");
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
              proUploadMsg.classList.remove("err"); proUploadMsg.classList.add("ok");
              proCsvInput.value = "";
              if (proMappingWrap) proMappingWrap.style.display = "none";
              fetch("/pro/contacts?accountId=" + encodeURIComponent(accountId))
                .then(function(r2) { return r2.json(); })
                .then(function(c) { if (!c.error) showProCount(c.total || 0, c.unsubscribed || 0); })
                .catch(function() { showProCount(data.total || data.imported || 0, 0); });
            } else {
              proUploadMsg.textContent = data.error || "Upload failed.";
              proUploadMsg.classList.remove("ok"); proUploadMsg.classList.add("err");
            }
          })
          .catch(function() {
            proUploadMsg.textContent = "Upload failed. Try again.";
            proUploadMsg.classList.remove("ok"); proUploadMsg.classList.add("err");
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
    const { autoReplyEnabled, contact, intervalMinutes, isPro } = req.body || {};
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
      ...(intervalMinutes !== undefined && { intervalMinutes: Number(intervalMinutes) }),
      ...(typeof isPro === "boolean" && { isPro })
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
  const events = getUpcomingEvents(365);
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
    const { status, messageText, offerText, sendDaysBefore } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const eventYear = parseInt(year, 10);
    const days = sendDaysBefore !== undefined ? Number(sendDaysBefore) : 14;
    await db.upsertProEventCampaign(accountId, key, eventYear, {
      status: status || "pending",
      messageText,
      offerText,
      sendDaysBefore: [0, 1, 3, 7, 14].includes(days) ? days : 14,
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
    const { accountId, type, eventName, offerText, prompt } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (type === "one_off") {
      const { subject, body } = await generateOneOffWithClaude({
        prompt: prompt ? String(prompt).trim() : "",
        businessName: business?.name || "Our business"
      });
      return res.json({ subject, body });
    }
    let messageText = await generateCampaignMessageWithClaude({
      type: type || "birthday",
      businessName: business?.name || "Our business",
      eventName,
      offerText: offerText ? String(offerText).trim() : "",
      businessPrompt: prompt ? String(prompt).trim() : ""
    });
    if (offerText && typeof messageText === "string") {
      messageText = messageText.replace(/\{\{offer\}\}/gi, String(offerText).trim());
    }
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
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Replyr Pro – Campaigns</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0f0f11;
    --surface: #17171a;
    --surface2: #1e1e22;
    --border: rgba(255,255,255,0.07);
    --accent: #4a9eff;
    --accent2: #7c6af7;
    --text: #f0ede8;
    --muted: #7a7880;
    --soft: rgba(74,158,255,0.1);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; padding: 0; }
  body::before {
    content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
    width: 800px; height: 500px;
    background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%);
    pointer-events: none; z-index: 0;
  }
  .wrapper { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; position: relative; z-index: 1; }
  .page-header { margin-bottom: 48px; }
  .back-link {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--muted); text-decoration: none; font-size: 13px; font-weight: 500; letter-spacing: 0.02em;
    margin-bottom: 24px; transition: color 0.2s;
  }
  .back-link:hover { color: var(--text); }
  .back-link svg { width: 14px; height: 14px; }
  .page-title { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 300; letter-spacing: -0.02em; color: var(--text); line-height: 1.1; }
  .page-title span { color: var(--accent); font-style: italic; }
  .compliance-note { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .compliance-note a { color: var(--accent2); text-decoration: none; }
  .compliance-note a:hover { text-decoration: underline; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 20px;
    padding: 32px; margin-bottom: 20px; animation: fadeUp 0.4s ease both;
  }
  .card:nth-child(2) { animation-delay: 0.05s; }
  .card:nth-child(3) { animation-delay: 0.1s; }
  .card:nth-child(4) { animation-delay: 0.15s; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .card-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 20px; }
  .card-icon {
    width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; font-size: 18px;
  }
  .card-icon.blue { background: rgba(74,158,255,0.15); }
  .card-icon.purple { background: rgba(124,106,247,0.15); }
  .card-icon.pink { background: rgba(255,130,130,0.12); }
  .card-title { font-family: 'Fraunces', serif; font-size: 20px; font-weight: 400; color: var(--text); line-height: 1.2; }
  .card-desc { font-size: 13px; color: var(--muted); margin-top: 4px; line-height: 1.55; }
  .toggle-row {
    display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
    padding: 12px 16px; background: var(--surface2); border-radius: 12px; border: 1px solid var(--border);
  }
  .toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; cursor: pointer; }
  .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
  .toggle-track {
    position: absolute; cursor: pointer; inset: 0;
    background: #333; border-radius: 20px; transition: 0.3s;
  }
  .toggle-track::before {
    content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px;
    background: #0f0f11; border-radius: 50%; transition: 0.3s; background: var(--text);
  }
  .toggle input:checked + .toggle-track { background: var(--accent); }
  .toggle input:checked + .toggle-track::before { transform: translateX(16px); background: var(--bg); }
  .toggle-label { font-size: 14px; font-weight: 500; color: var(--text); }
  .toggle-status {
    margin-left: auto; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--accent); background: var(--soft); padding: 3px 8px; border-radius: 20px;
  }
  .toggle-status.off { color: var(--muted); background: rgba(255,255,255,0.05); }
  label.field-label {
    display: block; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 8px;
  }
  textarea, input[type="text"], input[type="date"], select {
    width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 12px;
    color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; padding: 14px 16px;
    resize: vertical; transition: border-color 0.2s, box-shadow 0.2s; outline: none; line-height: 1.6;
  }
  textarea:focus, input[type="text"]:focus, input[type="date"]:focus, select:focus {
    border-color: rgba(74,158,255,0.4); box-shadow: 0 0 0 3px rgba(74,158,255,0.08);
  }
  select { cursor: pointer; min-height: 46px; }
  textarea { min-height: 180px; }
  #birthday-message { min-height: 220px; }
  #oneoff-body { min-height: 180px; }
  #oneoff-prompt { min-height: 90px; }
  .field-group { margin-bottom: 20px; }
  .field-hint { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.5; }
  .field-input { margin-bottom: 0; }
  .btn {
    display: inline-flex; align-items: center; gap: 7px; border: none; border-radius: 10px;
    font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer;
    padding: 11px 20px; transition: all 0.2s; letter-spacing: 0.01em;
  }
  .btn-generate {
    background: var(--surface2); color: var(--muted); border: 1px solid var(--border); margin-bottom: 20px;
  }
  .btn-generate:hover { background: rgba(124,106,247,0.15); color: var(--text); border-color: rgba(124,106,247,0.4); }
  .btn-generate svg { width: 15px; height: 15px; }
  .btn-generate:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #0f0f11; }
  .btn-primary:hover { background: #6bafff; transform: translateY(-1px); box-shadow: 0 4px 20px rgba(74,158,255,0.25); }
  .btn-primary:active { transform: translateY(0); }
  .btn-primary:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
  .btn-confirm {
    background: rgba(124,106,247,0.18); color: #a099f7; border: 1px solid rgba(124,106,247,0.25);
    font-size: 13px; padding: 8px 16px;
  }
  .btn-confirm:hover { background: rgba(124,106,247,0.28); color: #c4beff; border-color: rgba(124,106,247,0.45); }
  .btn-confirm:disabled { opacity: 0.7; cursor: default; }
  .btn-skip {
    background: transparent; color: var(--muted); border: 1px solid var(--border); font-size: 13px; padding: 8px 16px;
  }
  .btn-skip:hover { background: rgba(255,255,255,0.04); color: var(--text); }
  .btn-skip:disabled { opacity: 0.7; cursor: default; }
  .btn-confirm.event-edit { background: rgba(124,106,247,0.2); color: var(--accent2); }
  .btn-confirm.event-edit:hover { background: rgba(124,106,247,0.3); color: var(--text); }
  .btn-undo { background: transparent; color: var(--muted); border: 1px solid var(--border); font-size: 12px; padding: 6px 12px; }
  .btn-undo:hover { color: var(--accent); border-color: rgba(74,158,255,0.4); }
  .events-list { display: flex; flex-direction: column; gap: 8px; }
  .event-row {
    display: flex; align-items: center; padding: 14px 16px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 12px; transition: border-color 0.2s, background 0.2s;
  }
  .event-row:hover { border-color: rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); }
  .event-emoji { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; margin-right: 12px; }
  .event-info { flex: 1; }
  .event-name { font-size: 14px; font-weight: 600; color: var(--text); }
  .event-date { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .event-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .event-detail-panel { display: none; margin-top: 16px; padding: 20px; background: var(--surface2); border: 1px solid var(--border); border-radius: 14px; }
  .event-detail-panel.visible { display: block; }
  .event-detail-title { font-family: 'Fraunces', serif; font-size: 18px; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .pro-msg { margin-top: 8px; font-size: 13px; color: var(--muted); }
  .pro-msg.ok { color: #6ee7a3; }
  .pro-msg.err { color: #f87171; }
  @media (max-width: 500px) { .form-row { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrapper" id="pro-app" data-account-id="${escapeHtml(accountId)}">
  <div class="page-header">
    <a href="/connected?accountId=${encodeURIComponent(accountId)}" class="back-link">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 3L5 8l5 5"/></svg>
      Back to Connected
    </a>
    <h1 class="page-title">Replyr Pro <span>Campaigns</span></h1>
    <p class="compliance-note">By uploading and sending you confirm you have permission to email those contacts. <a href="/compliance">Compliance →</a></p>
  </div>

  <div class="card">
    <div class="card-header">
      <div class="card-icon blue">🎂</div>
      <div>
        <div class="card-title">Birthday messages</div>
        <div class="card-desc">One message used for all birthday emails. Use <code style="color:var(--accent);font-size:12px">{{first_name}}</code> and <code style="color:var(--accent);font-size:12px">{{offer}}</code> — filled automatically from your customer list.</div>
      </div>
    </div>
    <div class="toggle-row">
      <label class="toggle">
        <input type="checkbox" id="birthday-enabled" ${birthday?.enabled ? "checked" : ""}>
        <span class="toggle-track"></span>
      </label>
      <span class="toggle-label">Enable birthday emails</span>
      <span class="toggle-status ${birthday?.enabled ? "" : "off"}" id="toggle-status">${birthday?.enabled ? "Active" : "Off"}</span>
    </div>
    <div class="field-group">
      <label class="field-label">Describe your business (optional)</label>
      <input type="text" id="birthday-prompt" placeholder="e.g. Anchovie and Salts is a seafood restaurant in Seattle — tailor the message to that" class="field-input">
      <p class="field-hint">Add a short description so Replyr can tailor the birthday message to your business name and type.</p>
    </div>
    <div class="field-group">
      <label class="field-label">Message</label>
      <textarea id="birthday-message" placeholder="Happy birthday, {{first_name}}! As a thank you, {{offer}}...">${escapeHtml(birthday?.messageText || "")}</textarea>
    </div>
    <button type="button" class="btn btn-generate" id="birthday-generate">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>
      Generate with Replyr
    </button>
    <div class="field-group">
      <label class="field-label">Offer</label>
      <input type="text" id="birthday-offer" value="${escapeHtml(birthday?.offerText || "")}" placeholder="e.g. 20% off next visit">
    </div>
    <button type="button" class="btn btn-primary" id="birthday-save">Save changes</button>
    <span id="birthday-msg" class="pro-msg" aria-live="polite"></span>
  </div>

  <div class="card">
    <div class="card-header">
      <div class="card-icon purple">📅</div>
      <div>
        <div class="card-title">Upcoming events</div>
        <div class="card-desc">Opt in per event. We show the <strong style="color:var(--text)">event date</strong> (the holiday); you choose <strong style="color:var(--text)">when to send</strong> — 2 weeks before, 1 week before, or on the day. Set message and offer, then Confirm.</div>
      </div>
    </div>
    <div class="events-list" id="events-list"></div>
    <div class="event-detail-panel" id="event-detail-panel">
      <div class="event-detail-title" id="event-detail-title">Event</div>
      <div class="field-group">
        <label class="field-label">Describe your business (optional)</label>
        <input type="text" id="event-detail-prompt" placeholder="e.g. Anchovie and Salts is a seafood restaurant — tailor the message" class="field-input">
        <p class="field-hint">So Replyr can tailor the event message to your business.</p>
      </div>
      <div class="field-group">
        <label class="field-label">Message</label>
        <textarea id="event-detail-message" placeholder="e.g. Happy Easter! {{first_name}}, {{offer}}... Use {{first_name}} and {{offer}}." style="min-height: 160px;"></textarea>
      </div>
      <button type="button" class="btn btn-generate" id="event-detail-generate">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>
        Generate with Replyr
      </button>
      <div class="field-group">
        <label class="field-label">Offer</label>
        <input type="text" id="event-detail-offer" placeholder="e.g. 20% off next visit">
      </div>
      <div class="field-group">
        <label class="field-label">When to send</label>
        <select id="event-detail-send" class="field-input">
          <option value="0">On the event day</option>
          <option value="1">1 day before</option>
          <option value="3">3 days before</option>
          <option value="7">1 week before</option>
          <option value="14" selected>2 weeks before</option>
        </select>
      </div>
      <button type="button" class="btn btn-primary" id="event-detail-save">Save and confirm</button>
      <span id="event-detail-msg" class="pro-msg" aria-live="polite"></span>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <div class="card-icon pink">⚡</div>
      <div>
        <div class="card-title">One-off promo</div>
        <div class="card-desc">Schedule a single campaign for any date. Use <code style="color:var(--accent);font-size:12px">{{first_name}}</code> in the body — filled automatically from your customer list.</div>
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">Describe your promo</label>
      <textarea id="oneoff-prompt" placeholder="e.g. Mother's Day 20% off manicures, or Summer sale – free nail art with any service"></textarea>
    </div>
    <button type="button" class="btn btn-generate" id="oneoff-generate">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>
      Generate with Replyr
    </button>
    <div class="form-row">
      <div class="field-group" style="margin-bottom:0">
        <label class="field-label">Send date</label>
        <input type="date" id="oneoff-date">
      </div>
      <div class="field-group" style="margin-bottom:0">
        <label class="field-label">Subject line</label>
        <input type="text" id="oneoff-subject" placeholder="Subject line">
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">Body</label>
      <textarea id="oneoff-body" placeholder="Email body..."></textarea>
    </div>
    <button type="button" class="btn btn-primary" id="oneoff-schedule">Schedule campaign</button>
    <span id="oneoff-msg" class="pro-msg" aria-live="polite"></span>
  </div>
</div>
<script src="/pro.js"></script>
</body>
</html>`);
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

  var eventEmoji = { valentines_day: "❤️", presidents_day: "🎩", lunar_new_year: "🧧", easter: "🐣", mothers_day: "🌷", memorial_day: "🎖️", fathers_day: "👔", independence_day: "🇺🇸", labor_day: "📋", halloween: "🎃", thanksgiving: "🦃", black_friday: "🛒", christmas: "🎄", new_year: "⭐" };
  function loadEvents() {
    fetch("/pro/events").then(function(r) { return r.json(); }).then(function(events) {
      var el = document.getElementById("events-list");
      if (!el) return;
      function fmtDate(iso) {
        try {
          var d = new Date(iso + "T12:00:00");
          return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        } catch (_) { return iso; }
      }
      el.innerHTML = events.slice(0, 14).map(function(ev) {
        var eventDateStr = fmtDate(ev.sendDate);
        var emoji = eventEmoji[ev.key] || "📅";
        var y = ev.sendDate.slice(0, 4);
        return '<div class="event-row" data-key="' + ev.key + '" data-year="' + y + '">' +
          '<div class="event-emoji">' + emoji + '</div>' +
          '<div class="event-info"><div class="event-name">' + ev.name + '</div><div class="event-date">' + eventDateStr + '</div></div>' +
          '<div class="event-actions">' +
          '<button type="button" class="btn btn-confirm event-confirm" data-key="' + ev.key + '" data-year="' + y + '" data-name="' + (ev.name || "").replace(/"/g, "&quot;") + '" data-date="' + eventDateStr.replace(/"/g, "&quot;") + '">Confirm</button>' +
          '<button type="button" class="btn btn-skip event-skip" data-key="' + ev.key + '" data-year="' + y + '">Skip</button>' +
          '<button type="button" class="btn btn-undo event-undo" data-key="' + ev.key + '" data-year="' + y + '" style="display:none">Undo</button>' +
          '</div></div>';
      }).join("");
      var panel = document.getElementById("event-detail-panel");
      var panelTitle = document.getElementById("event-detail-title");
      var panelMessage = document.getElementById("event-detail-message");
      var panelOffer = document.getElementById("event-detail-offer");
      var panelSend = document.getElementById("event-detail-send");
      var panelPrompt = document.getElementById("event-detail-prompt");
      var panelMsg = document.getElementById("event-detail-msg");
      el.querySelectorAll(".event-confirm").forEach(function(btn) {
        btn.onclick = function() {
          if (btn.disabled) return;
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          var name = btn.getAttribute("data-name") || key.replace(/_/g, " ");
          var dateStr = btn.getAttribute("data-date") || "";
          panel.dataset.key = key;
          panel.dataset.year = year;
          panel.dataset.eventName = name;
          panel._confirmBtn = btn;
          panelTitle.textContent = name + (dateStr ? " – " + dateStr : "");
          panelMessage.value = "";
          panelOffer.value = "";
          panelSend.value = "14";
          panelPrompt.value = "";
          panelMsg.textContent = "";
          panel.classList.add("visible");
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId))
            .then(function(r) { return r.json(); })
            .then(function(c) {
              if (c && c.messageText) panelMessage.value = c.messageText;
              if (c && c.offerText) panelOffer.value = c.offerText;
              if (c && c.sendDaysBefore !== undefined) panelSend.value = String(c.sendDaysBefore);
              if (c && c.status === "confirmed") { btn.textContent = "Edit"; btn.classList.add("event-edit"); }
            })
            .catch(function() {});
        };
      });
      el.querySelectorAll(".event-skip").forEach(function(btn) {
        btn.onclick = function() {
          if (btn.disabled) return;
          var row = btn.closest(".event-row");
          var undoBtn = row ? row.querySelector(".event-undo") : null;
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: accountId, status: "skipped" })
          }).then(function(r) { return r.json(); }).then(function() {
            btn.textContent = "Skipped";
            btn.disabled = true;
            if (undoBtn) undoBtn.style.display = "";
          });
        };
      });
      el.querySelectorAll(".event-undo").forEach(function(btn) {
        btn.onclick = function() {
          var row = btn.closest(".event-row");
          var skipBtn = row ? row.querySelector(".event-skip") : null;
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: accountId, status: "pending" })
          }).then(function(r) { return r.json(); }).then(function() {
            if (skipBtn) { skipBtn.textContent = "Skip"; skipBtn.disabled = false; }
            btn.style.display = "none";
          }).catch(function() { alert("Undo failed"); });
        };
      });
    });
  }
  loadEvents();

  var eventDetailPanel = document.getElementById("event-detail-panel");
  var eventDetailGenerate = document.getElementById("event-detail-generate");
  var eventDetailSave = document.getElementById("event-detail-save");
  if (eventDetailGenerate) {
    var eventDetailGenerateOrig = eventDetailGenerate.innerHTML;
    eventDetailGenerate.onclick = function() {
      if (!eventDetailPanel || !eventDetailPanel.dataset.key) return;
      var eventName = eventDetailPanel.dataset.eventName || "";
      var offerText = (document.getElementById("event-detail-offer") && document.getElementById("event-detail-offer").value) ? document.getElementById("event-detail-offer").value.trim() : "";
      var businessPrompt = (document.getElementById("event-detail-prompt") && document.getElementById("event-detail-prompt").value) ? document.getElementById("event-detail-prompt").value.trim() : "";
      eventDetailGenerate.disabled = true;
      eventDetailGenerate.innerHTML = eventDetailGenerateOrig.replace(/Generate with Replyr/g, "Thinking…");
      fetch("/pro/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "event", eventName: eventName, offerText: offerText, prompt: businessPrompt })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var ta = document.getElementById("event-detail-message");
        if (ta && data.messageText) ta.value = data.messageText;
      }).catch(function() { alert("Generate failed"); }).finally(function() {
        eventDetailGenerate.innerHTML = eventDetailGenerateOrig;
        eventDetailGenerate.disabled = false;
      });
    };
  }
  if (eventDetailSave) {
    eventDetailSave.onclick = function() {
      if (!eventDetailPanel || !eventDetailPanel.dataset.key) return;
      var key = eventDetailPanel.dataset.key;
      var year = eventDetailPanel.dataset.year;
      var message = document.getElementById("event-detail-message") ? document.getElementById("event-detail-message").value : "";
      var offer = document.getElementById("event-detail-offer") ? document.getElementById("event-detail-offer").value : "";
      var sendEl = document.getElementById("event-detail-send");
      var sendDaysBefore = sendEl ? parseInt(sendEl.value, 10) : 14;
      var msgEl = document.getElementById("event-detail-msg");
      eventDetailSave.disabled = true;
      if (msgEl) msgEl.textContent = "";
      fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, status: "confirmed", messageText: message, offerText: offer, sendDaysBefore: sendDaysBefore })
      }).then(function(r) { return r.json(); }).then(function() {
        if (msgEl) { msgEl.textContent = "Saved and confirmed."; msgEl.className = "pro-msg ok"; }
        eventDetailPanel.classList.remove("visible");
        if (eventDetailPanel._confirmBtn) {
          eventDetailPanel._confirmBtn.textContent = "Edit";
          eventDetailPanel._confirmBtn.disabled = false;
          eventDetailPanel._confirmBtn.classList.add("event-edit");
        }
      }).catch(function() {
        if (msgEl) { msgEl.textContent = "Save failed."; msgEl.className = "pro-msg err"; }
      }).finally(function() { eventDetailSave.disabled = false; });
    };
  }

  var birthdayCheck = document.getElementById("birthday-enabled");
  var toggleStatus = document.getElementById("toggle-status");
  if (birthdayCheck && toggleStatus) {
    birthdayCheck.addEventListener("change", function() { toggleStatus.textContent = birthdayCheck.checked ? "Active" : "Off"; toggleStatus.classList.toggle("off", !birthdayCheck.checked); });
  }

  var birthdayGenerate = document.getElementById("birthday-generate");
  if (birthdayGenerate) {
    var birthdayGenerateOrig = birthdayGenerate.innerHTML;
    birthdayGenerate.onclick = function() {
      var offerInput = document.getElementById("birthday-offer");
      var promptInput = document.getElementById("birthday-prompt");
      var offerText = (offerInput && offerInput.value) ? offerInput.value.trim() : "";
      var businessPrompt = (promptInput && promptInput.value) ? promptInput.value.trim() : "";
      birthdayGenerate.disabled = true;
      birthdayGenerate.innerHTML = birthdayGenerateOrig.replace(/Generate with Replyr/g, "Thinking…");
      fetch("/pro/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "birthday", offerText: offerText, prompt: businessPrompt })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var ta = document.getElementById("birthday-message");
        if (ta && data.messageText) ta.value = data.messageText;
      }).catch(function() { alert("Generate failed"); }).finally(function() {
        birthdayGenerate.innerHTML = birthdayGenerateOrig;
        birthdayGenerate.disabled = false;
      });
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
        var m = document.getElementById("birthday-msg"); m.textContent = "Saved."; m.className = "pro-msg ok";
      }).catch(function() {
        var m = document.getElementById("birthday-msg"); m.textContent = "Save failed."; m.className = "pro-msg err";
      }).finally(function() { birthdaySave.disabled = false; });
    };
  }

  var oneoffGenerate = document.getElementById("oneoff-generate");
  if (oneoffGenerate) {
    var oneoffGenerateOrig = oneoffGenerate.innerHTML;
    oneoffGenerate.onclick = function() {
      var promptEl = document.getElementById("oneoff-prompt");
      var promptText = (promptEl && promptEl.value) ? promptEl.value.trim() : "";
      if (!promptText) { alert("Describe your promo first (e.g. Mother's Day 20% off)."); return; }
      oneoffGenerate.disabled = true;
      oneoffGenerate.innerHTML = oneoffGenerateOrig.replace(/Generate with Replyr/g, "Thinking…");
      fetch("/pro/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "one_off", prompt: promptText })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var sub = document.getElementById("oneoff-subject");
        var bod = document.getElementById("oneoff-body");
        if (sub && data.subject) sub.value = data.subject;
        if (bod && data.body) bod.value = data.body;
      }).catch(function() { alert("Generate failed."); }).finally(function() {
        oneoffGenerate.innerHTML = oneoffGenerateOrig;
        oneoffGenerate.disabled = false;
      });
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
        var m = document.getElementById("oneoff-msg"); m.textContent = "Scheduled for " + date + "."; m.className = "pro-msg ok";
        document.getElementById("oneoff-date").value = "";
        document.getElementById("oneoff-subject").value = "";
        document.getElementById("oneoff-body").value = "";
      }).catch(function() {
        var m = document.getElementById("oneoff-msg"); m.textContent = "Failed."; m.className = "pro-msg err";
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
      const tableHtml = "<table><thead><tr><th>Name</th><th>Contact (for 1–2 star replies)</th><th>Trial ends</th><th>Status</th><th>Pro</th><th>Auto-reply</th><th>Interval (min)</th><th>Actions</th></tr></thead><tbody></tbody></table>";
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
          "<td><input type=\\"checkbox\\" " + (b.isPro ? "checked" : "") + " data-field=\\"isPro\\" title=\\"Pro (campaigns, CSV)\\"></td>" +
          "<td><input type=\\"checkbox\\" " + (b.autoReplyEnabled ? "checked" : "") + " data-field=\\"autoReplyEnabled\\"></td>" +
          "<td><input type=\\"number\\" min=\\"1\\" value=\\""
          + (b.intervalMinutes ?? 30)
          + "\\" data-field=\\"intervalMinutes\\" style=\\"width:4rem\\"></td>" +
          "<td><button type=\\"button\\" data-save>Save</button> <button type=\\"button\\" data-run-now title=\\"Run Claude auto-reply now\\">Run now</button> <a href=\\"#\\" data-pro-link title=\\"Open Pro campaigns page\\">Pro</a><span class=\\"msg\\" data-msg></span></td>";
        tbody.appendChild(tr);
      });
      content.querySelectorAll("[data-save]").forEach(btn => { btn.addEventListener("click", saveRow); });
      content.querySelectorAll("[data-run-now]").forEach(btn => { btn.addEventListener("click", runNowRow); });
      content.querySelectorAll("[data-pro-link]").forEach(function(a) {
        a.addEventListener("click", function(e) { e.preventDefault(); var tr = a.closest("tr"); if (tr && tr.dataset.accountId) window.open("/pro?accountId=" + encodeURIComponent(tr.dataset.accountId), "_blank"); });
      });
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
  const isPro = tr.querySelector("[data-field=isPro]").checked;
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
      body: JSON.stringify({ contact, isPro, autoReplyEnabled, intervalMinutes })
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
