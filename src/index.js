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
import Stripe from "stripe";

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

async function start() {
  if (db.useDb()) {
    await db.init();
    logger.info("Database initialized");
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    logger.info({ port }, "Server started");
    startScheduler(logger);
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
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const accountId = session.client_reference_id;
      const customerId = typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
      if (accountId) {
        const business = await getBusiness(accountId);
        if (business) {
          await upsertBusiness({
            ...business,
            subscribedAt: new Date().toISOString(),
            stripeCustomerId: customerId
          });
          req.log?.info({ accountId, customerId }, "Stripe: subscription recorded");
        }
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
      if (customerId) {
        const accountId = await getAccountIdByStripeCustomerId(customerId);
        if (accountId) {
          const business = await getBusiness(accountId);
          if (business) {
            await upsertBusiness({ ...business, subscribedAt: null });
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

// Create Stripe Checkout Session (so we can pass accountId and get it back in webhook)
app.post("/create-checkout-session", async (req, res, next) => {
  try {
    const { accountId } = req.body || {};
    const secret = process.env.STRIPE_SECRET_KEY;
    const priceId = process.env.STRIPE_PRICE_ID;
    const baseUrl = (process.env.BASE_URL || "").trim() || `${req.protocol}://${req.get("host") || ""}`;
    if (!secret || !priceId) {
      return res.status(503).json({ error: "Stripe not configured. Use the Subscribe link below." });
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
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; background: #f5f5f5; gap: 1.5rem; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 420px; text-align: center; }
    .card .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 1rem; }
    .card .logo { width: 36px; height: 36px; flex-shrink: 0; }
    .card .logo svg { width: 100%; height: 100%; display: block; }
    .card .brand-name { font-size: 1.25rem; font-weight: 700; color: #2C2D32; letter-spacing: -0.02em; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; color: #222; }
    p { margin: 0; color: #555; line-height: 1.5; font-size: 0.95rem; }
    .next-step { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.9rem; color: #555; }
    .next-step a { color: #2160F3; text-decoration: none; }
    .next-step a:hover { text-decoration: underline; }
    .free-reply { background: #fff; padding: 1.5rem 2.5rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 420px; text-align: center; }
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
    .trial-ending-soon a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
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
  const billingPortalUrl = (process.env.STRIPE_CUSTOMER_PORTAL_URL || "").trim();
  const accountId = (req.query.accountId && String(req.query.accountId).trim()) || "";
  const hasStripe = subscribeUrl.startsWith("http");
  const hasBillingPortal = billingPortalUrl.startsWith("http");
  const ctaHref = hasStripe ? subscribeUrl : (contact.startsWith("http") ? contact : (contact ? "mailto:" + contact : "#"));
  const ctaText = hasStripe ? "Subscribe with card" : "Contact us to subscribe";
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
  <div class="subscribe-page" data-account-id="${escapeHtml(accountId)}" data-fallback-url="${escapeHtml(ctaHref)}">
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
        <button type="button" id="subscribe-cta" class="cta-btn" style="border:none;cursor:pointer;font:inherit;">${escapeHtml(ctaText)}</button>
        <p id="subscribe-cta-msg" class="cta-msg" style="margin-top:0.5rem;font-size:0.9rem;min-height:1.2em;color:#c62828;" aria-live="polite"></p>
      </div>
    </div>
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
  var btn = document.getElementById("subscribe-cta");
  var msgEl = document.getElementById("subscribe-cta-msg");
  var page = document.querySelector(".subscribe-page");
  if (!btn || !page) return;
  var accountId = (page.getAttribute("data-account-id") || "").trim();
  var fallbackUrl = (page.getAttribute("data-fallback-url") || "").trim() || "#";
  function go(url, openInNewTab) {
    if (!url || url === "#" || url.indexOf("http") !== 0) {
      if (msgEl) { msgEl.textContent = "Subscribe link not set up. Add SUBSCRIBE_URL, or STRIPE_SECRET_KEY + STRIPE_PRICE_ID for Checkout."; }
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
  btn.addEventListener("click", function() {
    if (msgEl) msgEl.textContent = "";
    if (!accountId) { go(fallbackUrl, true); return; }
    btn.disabled = true;
    if (msgEl) msgEl.textContent = "Opening checkout…";
    fetch("/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: accountId })
    }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }).catch(function() { return { ok: false, data: null }; }); }).then(function(result) {
      if (result.data && result.data.url) { go(result.data.url, true); return; }
      if (!result.ok && result.data && result.data.error && msgEl) msgEl.textContent = result.data.error;
      go(fallbackUrl, true);
    }).catch(function() {
      if (msgEl) msgEl.textContent = "Request failed. Opening payment link in new tab…";
      go(fallbackUrl, true);
    }).finally(function() { btn.disabled = false; });
  });
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
    const { accountId, accountName } = await handleOAuthCallback(code.toString());
    const locations = await listLocations(accountId);
    const firstLocation = locations[0];
    const locationId = firstLocation?.name
      ? firstLocation.name.split("/").pop()
      : null;
    const name = firstLocation?.title || accountName || null;
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
