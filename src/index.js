import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import twilio from "twilio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import * as db from "./db.js";
import { getAuthUrl, handleOAuthCallback, getTokenStatus, replyToReview, listAccounts, listLocations, listReviews, validateState } from "./google.js";
import {
  setSessionCookie,
  readSessionAccountId,
  isValidAdminRequest,
  getAdminSecretFromRequest,
  canAccessAccount,
  signChooseLocationToken,
  verifyChooseLocationToken
} from "./sessionAuth.js";
import { processPendingReviews, startScheduler, getReplyText, addRepliedReviewId } from "./auto.js";
import {
  getAllBusinesses,
  getBusiness,
  upsertBusiness,
  getAccountIdByStripeCustomerId,
  isGratisAccount,
  setNotificationEmailIfEmpty
} from "./businesses.js";
import { replaceProContacts, getProContactsCount, getProContactsList, setProContactUnsubscribed } from "./proContacts.js";
import { parseProCsv, validateFile } from "./csvPro.js";
import { verifyUnsubscribeToken } from "./campaignEmail.js";
import { generateCampaignMessageWithClaude, generateOneOffWithClaude } from "./ai.js";
import {
  getUpcomingEvents,
  getEventSendDate,
  getSendDateForEvent,
  sendBirthdayCampaignsForAccount,
  sendEventCampaignForAccount,
  sendProEventCampaignTest,
  sendOneOffCampaign
} from "./proCampaigns.js";
import multer from "multer";
import Stripe from "stripe";
import { getCurrentMonthKey, getIncludedSmsForTier, normalizeProTier } from "./proPlan.js";
import * as sentry from "./sentry.js";
import {
  getProPriceIds,
  subscriptionHasProPrice as proPriceMatches,
  getProTierFromSubscription as proTierFromSub,
  getProTierFromCheckoutMetadata,
  subscribedAtForSubscriptionStatus,
  subscriptionStatusKeepsAccess
} from "./stripePricing.js";
import { verifyCancelToken } from "./replyDelay.js";
import {
  getPlanAmountsCents,
  computeMrr,
  computeFunnel,
  formatCentsAsUsd
} from "./metrics.js";

const app = express();
app.set("trust proxy", 1);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const authRouteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Try again later." }
});
const freeReplyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many free-reply requests. Try again later." }
});
const aiCampaignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI or campaign requests. Try again later." }
});

function getTwilioWebhookUrl(req) {
  const base = (process.env.BASE_URL || "").trim().replace(/\/$/, "");
  if (base.startsWith("http")) return `${base}/webhooks/twilio/sms`;
  return `${req.protocol}://${req.get("host") || "localhost"}/webhooks/twilio/sms`;
}

/** Base Replyr ($19) Checkout price — `STRIPE_PRICE_ID` or optional alias `STRIPE_BASE_PRICE_ID`. */
function getStripeCorePriceId() {
  return (process.env.STRIPE_PRICE_ID || process.env.STRIPE_BASE_PRICE_ID || "").trim();
}

/** @returns {boolean} false if response already sent */
function guardBusinessAccess(req, res, accountId) {
  const id = (accountId && String(accountId).trim()) || "";
  if (!id) {
    res.status(400).json({ error: "accountId is required" });
    return false;
  }
  if (!canAccessAccount(req, id)) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

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
        sentry.captureException(err, { kind: "birthday-campaign", accountId });
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    const pacificNowLocal = getPacificNowLocalMinute();
    const eventDue = await db.getProEventCampaignsDueToSend();
    for (const { accountId, eventKey, eventYear, sendDaysBefore, sendAtLocal } of eventDue) {
      let shouldSend = false;
      if (sendAtLocal && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sendAtLocal)) {
        shouldSend = sendAtLocal <= pacificNowLocal;
      } else {
        // Backward compatibility for older rows that only have send_days_before.
        const eventDate = getEventSendDate(eventKey, eventYear);
        const sendDate = getSendDateForEvent(eventDate, sendDaysBefore);
        shouldSend = sendDate === today;
      }
      if (!shouldSend) continue;
      try {
        await sendEventCampaignForAccount(accountId, eventKey, eventYear, logger);
      } catch (err) {
        logger.error({ err, accountId, eventKey }, "Event campaign send failed");
        sentry.captureException(err, { kind: "event-campaign", accountId, eventKey, eventYear });
      }
    }
    const oneOffDue = await db.getProOneOffCampaignsDueToSend();
    for (const row of oneOffDue) {
      try {
        await sendOneOffCampaign(row.id, row.account_id, row.subject, row.body, logger, row);
      } catch (err) {
        logger.error({ err, id: row.id }, "One-off campaign send failed");
        sentry.captureException(err, { kind: "oneoff-campaign", id: row.id, accountId: row.account_id });
      }
    }
  } catch (err) {
    logger.error({ err }, "Campaign scheduler failed");
    sentry.captureException(err, { kind: "campaign-scheduler" });
  }
}

function getPacificNowLocalMinute() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const pick = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
}

async function start() {
  if (process.env.NODE_ENV === "production" && !(process.env.REPLYR_SESSION_SECRET || "").trim()) {
    logger.fatal("REPLYR_SESSION_SECRET is required in production for secure sessions");
    process.exit(1);
  }
  if (sentry.isEnabled()) {
    await sentry.init();
    logger.info("Sentry initialized");
  }
  if (db.useDb()) {
    await db.init();
    logger.info("Database initialized");
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    logger.info({ port }, "Server started");
    logger.info(
      {
        stripeBasePriceIdSet: Boolean(getStripeCorePriceId()),
        stripeProStarterSet: Boolean((process.env.STRIPE_PRO_STARTER_PRICE_ID || "").trim()),
        stripeProGrowthSet: Boolean((process.env.STRIPE_PRO_GROWTH_PRICE_ID || "").trim())
      },
      "Stripe: base Replyr uses STRIPE_PRICE_ID or STRIPE_BASE_PRICE_ID; Pro uses STRIPE_PRO_*"
    );
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

app.use(sentry.requestHandler());
app.use(helmet());
app.use(cors(corsOptions));
app.use(pinoHttp({ logger }));
// Stripe webhook needs raw body for signature verification (must be before express.json())
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhook);
// Twilio incoming SMS webhook (form-urlencoded) – handle STOP / UNSUBSCRIBE etc.
app.post("/webhooks/twilio/sms", express.urlencoded({ extended: true }), twilioSmsWebhook);
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

// Public cancel link from the auto-reply preview email.
// Token is HMAC-signed (REPLYR_SESSION_SECRET) and bound to (account, location, review).
//
// GET only renders a confirm page — it does NOT perform the cancel. This stops
// email link-prefetchers (Gmail, Apple Mail, Outlook safety scans) from
// auto-cancelling a reply just by fetching the link. Actual cancellation
// happens via POST from the form submit on that confirm page.
app.get("/auto-reply/cancel", async (req, res, next) => {
  try {
    const token = String(req.query.token || "").trim();
    const secret = (process.env.REPLYR_SESSION_SECRET || "").trim();
    const verified = secret ? verifyCancelToken(token, secret) : null;
    if (!verified) {
      return res
        .status(400)
        .type("html")
        .send(renderCancelPage({ ok: false, message: "This cancel link is invalid or expired." }));
    }
    if (!db.useDb()) {
      return res
        .status(503)
        .type("html")
        .send(renderCancelPage({ ok: false, message: "Cancel is unavailable in file-store mode." }));
    }
    res
      .status(200)
      .type("html")
      .send(renderCancelConfirmPage({ token }));
  } catch (err) {
    req.log?.error(err, "Cancel reply confirmation failed");
    sentry.captureException(err, { kind: "cancel-reply-confirm" });
    next(err);
  }
});

app.post("/auto-reply/cancel", express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const token = String(req.body?.token || "").trim();
    const secret = (process.env.REPLYR_SESSION_SECRET || "").trim();
    const verified = secret ? verifyCancelToken(token, secret) : null;
    if (!verified) {
      return res
        .status(400)
        .type("html")
        .send(renderCancelPage({ ok: false, message: "This cancel link is invalid or expired." }));
    }
    if (!db.useDb()) {
      return res
        .status(503)
        .type("html")
        .send(renderCancelPage({ ok: false, message: "Cancel is unavailable in file-store mode." }));
    }
    const cancelled = await db.cancelPendingReply(verified.accountId, verified.locationId, verified.reviewId);
    if (!cancelled) {
      return res
        .status(200)
        .type("html")
        .send(
          renderCancelPage({
            ok: false,
            message: "This reply was already sent or cancelled. Nothing to do."
          })
        );
    }
    // Mark the review as handled so the auto-reply scheduler doesn't queue
    // another reply for it on the next tick.
    await addRepliedReviewId(verified.accountId, verified.locationId, verified.reviewId);
    res
      .status(200)
      .type("html")
      .send(
        renderCancelPage({
          ok: true,
          message: "Reply cancelled. Replyr will not post an auto-reply to this Google review."
        })
      );
  } catch (err) {
    req.log?.error(err, "Cancel reply failed");
    sentry.captureException(err, { kind: "cancel-reply" });
    next(err);
  }
});

function renderCancelPage({ ok, message }) {
  const color = ok ? "#2e7d32" : "#c62828";
  const safeMessage = escapeHtml(message || "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Replyr — Cancel reply</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 2.5rem 1.5rem; max-width: 520px; margin: 0 auto; color: #222; }
  .card { padding: 1.5rem; border: 1px solid #e0e0e0; border-radius: 8px; }
  h1 { margin: 0 0 0.5rem 0; font-size: 1.25rem; color: ${color}; }
  p { margin: 0.5rem 0; line-height: 1.45; }
  a { color: #0366d6; }
</style></head>
<body>
  <div class="card">
    <h1>${ok ? "Cancelled" : "Couldn't cancel"}</h1>
    <p>${safeMessage}</p>
    <p style="margin-top:1.25rem;font-size:0.9em;color:#666;">— Replyr</p>
  </div>
</body></html>`;
}

function renderCancelConfirmPage({ token }) {
  const safeToken = escapeHtml(token || "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Replyr — Confirm cancel</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 2.5rem 1.5rem; max-width: 520px; margin: 0 auto; color: #222; }
  .card { padding: 1.5rem; border: 1px solid #e0e0e0; border-radius: 8px; }
  h1 { margin: 0 0 0.5rem 0; font-size: 1.25rem; color: #222; }
  p { margin: 0.5rem 0; line-height: 1.45; }
  button { margin-top: 1rem; padding: 0.65rem 1rem; border: 0; border-radius: 6px; background: #c0392b; color: #fff; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
  button:hover { background: #a93226; }
</style></head>
<body>
  <div class="card">
    <h1>Cancel this auto-reply?</h1>
    <p>Replyr will not post an auto-reply to this Google review.</p>
    <form method="post" action="/auto-reply/cancel">
      <input type="hidden" name="token" value="${safeToken}">
      <button type="submit">Cancel this reply</button>
    </form>
    <p style="margin-top:1.25rem;font-size:0.9em;color:#666;">— Replyr</p>
  </div>
</body></html>`;
}

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

// Test: send one campaign-style SMS. Set TEST_ALERT_SECRET and Twilio env vars. GET /test-sms?secret=...&to=4252899410 (to optional; defaults to ALERT_PHONE)
app.get("/test-sms", async (req, res, next) => {
  try {
    const secret = (req.query.secret || "").trim();
    const expected = process.env.TEST_ALERT_SECRET?.trim();
    if (!expected || secret !== expected) {
      return res.status(400).json({ error: "Missing or invalid secret. Set TEST_ALERT_SECRET and use ?secret= that value." });
    }
    const toParam = (req.query.to || "").trim();
    const alertPhone = process.env.ALERT_PHONE?.trim();
    const toPhone = toParam || alertPhone;
    if (!toPhone) {
      return res.status(400).json({ error: "No phone number. Set ALERT_PHONE in env or pass ?to=4252899410" });
    }
    const { sendCampaignSms, isSmsConfigured, getCampaignSmsDiagnostics } = await import("./campaignSms.js");
    if (!isSmsConfigured()) {
      return res.status(400).json({
        error:
          "Campaign SMS not configured. Set Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.",
        diag: getCampaignSmsDiagnostics()
      });
    }
    const body = "Replyr test: campaign SMS is working. Reply STOP to opt out.";
    await sendCampaignSms(toPhone, body, { bypassCampaignSmsEnabled: true });
    res.json({ ok: true, message: "Test SMS sent.", to: toPhone });
  } catch (err) {
    req.log?.error(err, "Test SMS failed");
    res.status(500).json({ error: err.message || "Test SMS failed. Check Twilio env vars." });
  }
});

// Diagnose campaign SMS env (no secrets). GET /test-sms-diag?secret=... — use after deploy if /test-sms says "not configured"
app.get("/test-sms-diag", async (req, res) => {
  const secret = (req.query.secret || "").trim();
  const expected = process.env.TEST_ALERT_SECRET?.trim();
  if (!expected || secret !== expected) {
    return res.status(400).json({ error: "Missing or invalid secret. Set TEST_ALERT_SECRET and use ?secret= that value." });
  }
  const { getCampaignSmsDiagnostics } = await import("./campaignSms.js");
  res.json(getCampaignSmsDiagnostics());
});

// Test: upcoming event campaign (one email and/or SMS to you only). Saves must include message body. Does not mark event sent.
// GET /test-trigger-event?secret=...&accountId=...&eventKey=easter&year=2026&email=you@x.com&to=+1425... (email/to optional; default ALERT_EMAIL / ALERT_PHONE)
app.get("/test-trigger-event", async (req, res, next) => {
  try {
    const secret = (req.query.secret || "").trim();
    const expected = process.env.TEST_ALERT_SECRET?.trim();
    if (!expected || secret !== expected) {
      return res.status(400).json({ error: "Missing or invalid secret. Set TEST_ALERT_SECRET and use ?secret= that value." });
    }
    const accountId = (req.query.accountId || "").trim();
    const eventKey = (req.query.eventKey || "").trim();
    const yearRaw = (req.query.year || req.query.eventYear || "").trim();
    const eventYear = parseInt(yearRaw, 10);
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    if (!eventKey) return res.status(400).json({ error: "eventKey required (e.g. easter, mothers_day)" });
    if (!yearRaw || Number.isNaN(eventYear)) return res.status(400).json({ error: "year required (e.g. year=2026)" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    const testEmail = (req.query.email || "").trim() || process.env.ALERT_EMAIL?.trim() || "";
    const testPhone = (req.query.to || "").trim() || process.env.ALERT_PHONE?.trim() || "";
    const firstName = (req.query.firstName || req.query.first_name || "Test").trim() || "Test";
    const result = await sendProEventCampaignTest(accountId, eventKey, eventYear, {
      testEmail,
      testPhone,
      firstName,
      logger: req.log
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log?.error(err, "Test trigger event failed");
    res.status(500).json({ error: err.message || "Test event send failed." });
  }
});

// Test: trigger birthday campaign for a date (e.g. 3/1/26). Set TEST_ALERT_SECRET. GET /test-trigger-birthday?secret=...&accountId=...&date=2026-03-01
app.get("/test-trigger-birthday", async (req, res, next) => {
  try {
    const secret = (req.query.secret || "").trim();
    const expected = process.env.TEST_ALERT_SECRET?.trim();
    if (!expected || secret !== expected) {
      return res.status(400).json({ error: "Missing or invalid secret. Set TEST_ALERT_SECRET and use ?secret= that value." });
    }
    const accountId = (req.query.accountId || "").trim();
    const date = (req.query.date || "").trim();
    if (!accountId) return res.status(400).json({ error: "accountId required" });
    if (!date) return res.status(400).json({ error: "date required (e.g. date=2026-03-01 for March 1)" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required" });
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Account is not Replyr Pro" });
    const result = await sendBirthdayCampaignsForAccount(accountId, req.log, date);
    res.json({ ok: true, sent: result.sent, message: `Birthday campaign ran for date ${date}. Emails sent: ${result.sent}.` });
  } catch (err) {
    req.log?.error(err, "Test trigger birthday failed");
    next(err);
  }
});

/** Twilio incoming SMS: handle STOP / UNSUBSCRIBE etc. and mark contact unsubscribed. */
async function twilioSmsWebhook(req, res) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    const signature = req.headers["x-twilio-signature"];
    const isProd = process.env.NODE_ENV === "production";
    if (isProd && !authToken) {
      req.log?.error?.("TWILIO_AUTH_TOKEN is required to process SMS webhooks in production");
      return res.status(403).send("Forbidden");
    }
    if (authToken && signature) {
      const url = getTwilioWebhookUrl(req);
      const valid = twilio.validateRequest(authToken, signature, url, req.body || {});
      if (!valid) {
        req.log?.warn?.("Twilio SMS webhook signature verification failed");
        return res.status(403).send("Forbidden");
      }
    } else if (isProd && authToken) {
      req.log?.warn?.("Twilio SMS webhook missing signature in production");
      return res.status(403).send("Forbidden");
    }
    const from = (req.body?.From || "").trim();
    const body = (req.body?.Body || "").trim().toUpperCase();
    const stopWords = ["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
    if (from && stopWords.includes(body)) {
      if (db.useDb()) {
        await db.setProContactUnsubscribedByPhone(from);
        req.log?.info?.({ from, body }, "SMS opt-out processed");
      }
    }
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    req.log?.error?.(err, "Twilio SMS webhook error");
    sentry.captureException(err, { kind: "twilio-sms-webhook" });
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
}

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
  const priceIds = getProPriceIds();
  const allProPriceIds = priceIds.all;

  function subscriptionHasProPrice(subscription) {
    return proPriceMatches(subscription, priceIds);
  }

  function getProTierFromSubscription(subscription) {
    return proTierFromSub(subscription, priceIds);
  }

  async function applySubscriptionState(accountId, subscribedAt, isPro, proTier) {
    if (!accountId) return;
    const business = await getBusiness(accountId);
    if (business) {
      await upsertBusiness({
        ...business,
        subscribedAt: subscribedAt === undefined ? business.subscribedAt || null : subscribedAt || null,
        isPro: !!isPro,
        ...(isPro ? { proTier: proTier || business.proTier || "starter" } : {})
      });
    }
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const accountId = session.client_reference_id;
      const customerId = typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
      const metadataProTier = getProTierFromCheckoutMetadata(session.metadata);
      let isPro = !!metadataProTier;
      let proTier = metadataProTier || "starter";
      if (allProPriceIds.length && session.subscription) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
          const sub = await stripe.subscriptions.retrieve(session.subscription, { expand: ["items.data.price"] });
          isPro = subscriptionHasProPrice(sub);
          proTier = getProTierFromSubscription(sub);
        } catch (e) {
          req.log?.warn({ err: e.message }, "Could not retrieve subscription for Pro check");
          if (!metadataProTier) {
            req.log?.warn({ accountId }, "Recording checkout without Pro metadata fallback");
          }
        }
      }
      if (accountId) {
        const business = await getBusiness(accountId);
        if (business) {
          await upsertBusiness({
            ...business,
            subscribedAt: new Date().toISOString(),
            stripeCustomerId: customerId,
            isPro,
            ...(isPro ? { proTier } : {})
          });
          req.log?.info({ accountId, customerId, isPro, proTier }, "Stripe: subscription recorded");
        }
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
      const accountId = customerId ? await getAccountIdByStripeCustomerId(customerId) : null;
      const keepsAccess = subscriptionStatusKeepsAccess(subscription.status);
      const isPro = keepsAccess && subscriptionHasProPrice(subscription);
      const proTier = isPro ? getProTierFromSubscription(subscription) : "starter";
      const business = accountId ? await getBusiness(accountId) : null;
      const subscribedAt = subscribedAtForSubscriptionStatus(subscription.status, business?.subscribedAt);
      await applySubscriptionState(accountId, subscribedAt, isPro, proTier);
      if (accountId) req.log?.info({ accountId, isPro, proTier }, "Stripe: subscription updated");
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
    sentry.captureException(err, { kind: "stripe-webhook", eventType: event?.type });
    return res.status(500).send("Webhook handler failed");
  }
  res.status(200).send();
}

// Create Stripe Checkout Session (so we can pass accountId and get it back in webhook).
// Body: { accountId, plan?: '', 'pro', 'pro_starter', 'pro_growth', 'pro_scale' }.
app.post("/create-checkout-session", aiCampaignLimiter, async (req, res, next) => {
  try {
    const { accountId, plan } = req.body || {};
    const secret = process.env.STRIPE_SECRET_KEY;
    const stripeCorePriceId = getStripeCorePriceId();
    const stripeProPriceId = (process.env.STRIPE_PRO_PRICE_ID || "").trim(); // legacy fallback
    const stripeProStarterPriceId = (process.env.STRIPE_PRO_STARTER_PRICE_ID || "").trim();
    const stripeProGrowthPriceId = (process.env.STRIPE_PRO_GROWTH_PRICE_ID || "").trim();
    const stripeProScalePriceId = (process.env.STRIPE_PRO_SCALE_PRICE_ID || "").trim();
    const requestedPlan = String(plan || "").trim().toLowerCase();
    const isPro = requestedPlan === "pro" || requestedPlan.startsWith("pro_");
    let selectedTier = null;
    let priceId = stripeCorePriceId;
    if (isPro) {
      if (requestedPlan === "pro_scale") {
        selectedTier = "scale";
        priceId = stripeProScalePriceId || stripeProPriceId;
      } else if (requestedPlan === "pro_growth") {
        selectedTier = "growth";
        priceId = stripeProGrowthPriceId || stripeProPriceId;
      } else {
        selectedTier = "starter";
        priceId = stripeProStarterPriceId || stripeProPriceId;
      }
    }
    const baseUrl = (process.env.BASE_URL || "").trim() || `${req.protocol}://${req.get("host") || ""}`;
    if (!secret || !priceId) {
      return res.status(503).json({
        error: isPro
          ? "Replyr Pro tier pricing is not configured (set STRIPE_PRO_STARTER_PRICE_ID / STRIPE_PRO_GROWTH_PRICE_ID / STRIPE_PRO_SCALE_PRICE_ID)."
          : "Set STRIPE_PRICE_ID (or STRIPE_BASE_PRICE_ID) for the $19 plan on the server — same Stripe account as your Pro prices."
      });
    }
    if (!accountId || typeof accountId !== "string") {
      return res.status(400).json({ error: "accountId is required" });
    }
    if (!canAccessAccount(req, accountId)) {
      return res.status(403).json({ error: "Sign in with Google required. Open /connected after connecting your business." });
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
      metadata: isPro ? { pro_tier: selectedTier || "starter" } : undefined,
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
  const body = isNoLocation
    ? `    <h1>No <em>business location</em> yet</h1>
    <p>Your Google account is connected, but there’s no business location linked yet. Replyr needs a Google Business Profile (and at least one location) to reply to reviews.</p>
    <p>Create or complete your <a href="https://business.google.com" target="_blank" rel="noopener">Google Business Profile</a>, then try connecting again.</p>
    <p style="margin-top:18px"><a href="/" class="doc-btn">← Back to Replyr</a></p>
    <p style="margin-top:14px;font-size:13px;"><a href="/contact">Contact us</a></p>`
    : `    <h1>No <em>Google Business Profile</em></h1>
    <p>Replyr works with <strong>Google Business Profile</strong>. The Google account you signed in with doesn’t have access to any business profile (or doesn’t own or manage one).</p>
    <p>If you have a business, create or claim your listing at <a href="https://business.google.com" target="_blank" rel="noopener">business.google.com</a>, then connect again. If you were just exploring, no problem — you can go back to the homepage.</p>
    <p style="margin-top:18px"><a href="/" class="doc-btn">← Back to Replyr</a></p>
    <p style="margin-top:14px;font-size:13px;"><a href="/contact">Contact us</a></p>`;
  res.send(darkShellHtml({
    title: "Replyr – No business profile",
    bodyHtml: body,
    narrow: true
  }));
});

// Dev-only fake-auth shortcut. Mints a session cookie + ensures a business
// record exists so /connected and /pro work without real Google OAuth. Requires
// REPLYR_DEV_LOGIN=1 AND NODE_ENV !== production — both must hold or the route
// 404s. Never enable in production.
app.get("/dev/login", async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production" || process.env.REPLYR_DEV_LOGIN !== "1") {
      return res.status(404).send("Not found");
    }
    const accountId = (req.query.accountId && String(req.query.accountId).trim()) || "dev-local";
    const wantPro = req.query.pro === "1";
    const existing = await getBusiness(accountId);
    await upsertBusiness({
      accountId,
      locationId: existing?.locationId || "dev-location",
      name: existing?.name || "Dev Local Business",
      isPro: wantPro || !!existing?.isPro
    });
    setSessionCookie(res, accountId);
    const returnToRaw = (req.query.return_to && String(req.query.return_to).trim()) || "";
    const returnTo = returnToRaw.startsWith("/") && !returnToRaw.startsWith("//")
      ? returnToRaw
      : `/connected?accountId=${encodeURIComponent(accountId)}`;
    res.redirect(returnTo);
  } catch (err) {
    next(err);
  }
});

// Dashboard: re-run Google sign-in and land back on /connected
app.get("/dashboard", authRouteLimiter, async (req, res, next) => {
  try {
    const returnToRaw = (req.query.return_to && String(req.query.return_to).trim()) || "";
    const returnTo = returnToRaw.startsWith("/") && !returnToRaw.startsWith("//") ? returnToRaw : null;
    const url = await getAuthUrl({ returnTo });
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
    let accountId = (req.query.accountId && String(req.query.accountId).trim()) || null;
    if (accountId && !canAccessAccount(req, accountId)) {
      const returnTo = encodeURIComponent(req.originalUrl || "/connected");
      return res.redirect(`/auth/google?return_to=${returnTo}`);
    }
    const justSubscribed = req.query.subscribed === "1";
    let currentContact = "";
    let currentAutoReply = false;
    let currentAutoReplyMode = "instant";
    let currentNotificationEmail = "";
    let businessName = "";
    let trialEndsAt = null;
    let trialDaysLeft = null;
    let trialEndDateFormatted = "";
    let subscribedAt = null;
    let trialEndedNoSubscription = false;
    let isPro = false;
    let gratisAccess = false;
    if (accountId) {
      let business = await getBusiness(accountId);
      // Backfill trial for existing businesses that connected before trial existed
      if (business && (business.trialEndsAt == null || business.trialEndsAt === "")) {
        const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await upsertBusiness({ ...business, trialEndsAt: endsAt });
        business = { ...business, trialEndsAt: endsAt };
      }
      currentContact = (business && business.contact) ? String(business.contact) : "";
      currentAutoReplyMode = (business && business.autoReplyMode) ? String(business.autoReplyMode) : "instant";
      currentNotificationEmail = (business && business.notificationEmail) ? String(business.notificationEmail) : "";
      businessName = (business && business.name) ? String(business.name) : "";
      subscribedAt = business?.subscribedAt ?? null;
      if (business && business.trialEndsAt) {
        const end = new Date(business.trialEndsAt);
        trialEndsAt = business.trialEndsAt;
        trialDaysLeft = Math.ceil((end - new Date()) / (24 * 60 * 60 * 1000));
        trialEndDateFormatted = end.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
      }
      isPro = !!(business && business.isPro);
      gratisAccess = isGratisAccount(accountId);
      trialEndedNoSubscription =
        !gratisAccess &&
        !isPro &&
        trialEndsAt != null &&
        trialDaysLeft != null &&
        trialDaysLeft < 0 &&
        !subscribedAt;
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
      gratisAccess && accountId
        ? `<div class="card trial-card">
  <div class="card-label">Your account</div>
  <div class="trial-days" style="color:var(--accent)">Complimentary access</div>
  <div class="trial-ends">You have full access to Replyr auto-reply at no charge.</div>
</div>`
        : trialEndsAt != null
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
      <input type="checkbox" id="auto-reply-toggle" role="switch" aria-checked="${currentAutoReply ? "true" : "false"}" aria-label="Reply to new Google reviews automatically" ${currentAutoReply ? "checked" : ""} ${trialEndedNoSubscription ? "disabled" : ""}>
      <div class="toggle-track"></div>
    </label>
    <span class="toggle-label">Reply to new Google reviews automatically</span>
  </div>
  ${trialEndedNoSubscription ? '<p class="trial-gate-msg" style="font-size:13px;color:var(--danger);margin-top:12px">Subscribe to re-enable auto-reply.</p>' : ""}
  <p id="auto-reply-msg" class="connected-msg" aria-live="polite"></p>
</div>`
      : "";
    const previewModeOn = currentAutoReplyMode === "delayed";
    const previewModeCard = accountId
      ? `<div class="card reply-preview-section" data-account-id="${escapeHtml(accountId)}">
  <div class="card-title">Reply preview (low-star reviews)</div>
  <div class="card-desc">For 1–3 star reviews, hold the AI-generated reply for 15 minutes and email you a cancel link before it posts. 4–5 star replies still post immediately.</div>
  <div class="toggle-row" style="margin-top:14px">
    <label class="toggle">
      <input type="checkbox" id="reply-preview-toggle" role="switch" aria-checked="${previewModeOn ? "true" : "false"}" aria-label="Email me before low-star replies post" ${previewModeOn ? "checked" : ""}>
      <div class="toggle-track"></div>
    </label>
    <span class="toggle-label">Email me before low-star replies post</span>
  </div>
  <div id="notification-email-row" class="contact-input-row" style="margin-top:14px${previewModeOn ? "" : ";display:none"}">
    <input type="email" id="notification-email-input" value="${escapeHtml(currentNotificationEmail)}" placeholder="you@example.com">
    <button type="button" id="notification-email-save-btn" class="btn-save">Save</button>
  </div>
  <p id="reply-preview-msg" class="connected-msg" aria-live="polite"></p>
</div>`
      : "";
    // Hide the "Try it now" demo once auto-reply is enabled — once the system is
    // replying automatically, the one-shot demo is just noise. The card toggles
    // with the auto-reply switch (see /connected.js).
    const tryItCard = accountId
      ? `<div class="card" id="free-reply-section" data-account-id="${escapeHtml(accountId)}"${currentAutoReply ? ' style="display:none"' : ""}>
  <div class="card-title">Try it now</div>
  <div class="card-desc">We'll reply to your latest unreplied review once, free. You'll see it on your Google listing.</div>
  <button type="button" id="free-reply-btn" class="btn btn-primary"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2L3 6l4 3 3 4 3-11z"/></svg>Send my 1 free reply</button>
  <p id="free-reply-msg" class="connected-msg" aria-live="polite"></p>
</div>`
      : "";
    const contactCard = accountId
      ? `<div class="card contact-section" data-account-id="${escapeHtml(accountId)}">
  <div class="card-title">Contact for 1–3 star replies</div>
  <div class="card-desc">If a customer leaves a low or mixed rating (1–3 stars), we'll suggest they reach out. Add your phone or email so the reply uses your real contact.</div>
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
    <div class="pro-card-intro">
      <div class="card-title">Replyr Pro – Customer list</div>
      <div class="card-desc" style="margin-bottom:0">Upload a CSV of customers for future promos and birthday messages.</div>
    </div>
    <div class="pro-stat-badges">
      <span class="contacts-badge" id="pro-contacts-count">0 contacts</span>
      <span class="contacts-badge" id="pro-sms-usage-badge">SMS this month: --/--</span>
    </div>
  </div>
  <p id="pro-sms-usage-msg" class="connected-msg" aria-live="polite" style="margin-top:10px"></p>
  ${isPro
    ? `<div class="field-specs"><ul class="field-specs-list"><li><strong>Required:</strong> column <code>email</code></li><li><strong>Recommended:</strong> <code>first_name</code> or <code>name</code>; <code>birthday</code> or <code>birth_date</code> (YYYY-MM-DD or MM/DD)</li><li><strong>Optional:</strong> <code>phone</code> (for SMS)</li></ul><p class="field-specs-foot">Max 5MB. Each upload replaces your current list. <a href="/compliance" style="color:var(--accent2);text-decoration:none">Compliance →</a></p></div>
  <label class="csv-zone"><input type="file" id="pro-csv-input" accept=".csv,text/csv,text/plain" aria-label="Choose CSV"> <div class="csv-icon">📂</div><div class="csv-zone-title">Drop your CSV here or click to browse</div><div class="csv-zone-sub">No file chosen · Max 5MB</div></label>
  <div id="pro-mapping-wrap" class="pro-mapping-wrap" style="display:none;"><p class="pro-mapping-label">Map your columns:</p><div class="pro-mapping-row"><label>Email *</label><select id="pro-map-email" data-field="email"></select></div><div class="pro-mapping-row"><label>First name</label><select id="pro-map-first_name" data-field="first_name"><option value="">— Don't use —</option></select></div><div class="pro-mapping-row"><label>Birthday</label><select id="pro-map-birthday" data-field="birthday"><option value="">— Don't use —</option></select></div><div class="pro-mapping-row"><label>Phone</label><select id="pro-map-phone" data-field="phone"><option value="">— Don't use —</option></select></div></div>
  <button type="button" id="pro-upload-btn" class="btn btn-ghost" style="max-width:180px"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v9M4 8l4 4 4-4"/><path d="M2 14h12"/></svg>Upload CSV</button>
  <p id="pro-upload-msg" class="connected-msg" aria-live="polite"></p>
  <div style="margin-top:12px"><button type="button" id="pro-view-customers-btn" class="btn btn-ghost" style="font-size:13px">View customers</button></div>
  <div id="pro-customers-list-wrap" style="display:none;margin-top:16px;overflow-x:auto"><table class="pro-customers-table" id="pro-customers-table"><thead><tr><th>Email</th><th>First name</th><th>Birthday</th><th>Phone</th><th>Status</th></tr></thead><tbody id="pro-customers-tbody"></tbody></table><div id="pro-customers-pagination" style="margin-top:10px;font-size:13px;color:var(--muted)"></div></div>
  <div class="pro-manage-row"><a href="/pro?accountId=${encodeURIComponent(accountId)}" class="manage-link manage-link-block">🗓 Manage campaigns <span class="manage-link-sub">(birthday, events, one-off)</span> →</a></div>`
    : `<div class="card-desc" style="margin-bottom:12px">Replyr Pro turns your customer list into automated, personal outreach. This is included in <strong>Replyr Pro</strong>.</div>
  <ul class="pro-benefits"><li><strong>Customer database</strong> — Upload a CSV (email, name, birthday, phone). We store it securely per business.</li><li><strong>Birthday messages</strong> — We automatically email and text customers on their birthday. Add a coupon or any offer you choose.</li><li><strong>Holiday & event campaigns</strong> — Mothers Day, Fathers Day, and more by email and SMS. You pick the discount or message.</li><li><strong>Your voice or ours</strong> — Curate the message yourself or let Replyr write it.</li><li><strong>Sent on your behalf</strong> — Messages go out with your business name (email and SMS); replies go to your contact email.</li></ul>
  <p class="card-desc" style="margin-bottom:8px">By uploading and sending you confirm you have permission to email and text those contacts. We send email to contacts with an address; if SMS is enabled, we also send a short text to contacts with a mobile number. <a href="/compliance" style="color:var(--accent2)">Compliance</a>.</p>
  <p><a href="/subscribe?accountId=${encodeURIComponent(accountId)}" class="manage-link">Upgrade to Pro →</a> to unlock the customer list and automated campaigns.</p>`}
</div>`
      : "";
    const freeReplySection = accountId
      ? `<div class="connected-body">
  <aside class="connected-sidebar" aria-label="Account and review tools">
    <div class="connected-stack">${trialCard}${autoReplyCard}${previewModeCard}${tryItCard}${contactCard}</div>
  </aside>
  <div class="connected-pro-wrap">${proCard}</div>
</div>`
      : "";
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Replyr – Connected</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #7a7880; --danger: #ff6b6b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; overflow-x: hidden; }
  body::before { content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%); width: 800px; height: 500px; background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%); pointer-events: none; z-index: 0; }
  .wrapper { width: 100%; max-width: 1120px; margin: 0 auto; padding: 48px 24px 80px; position: relative; z-index: 1; }
  .hero-card { background: var(--surface); border: 1px solid var(--border); border-radius: 24px; padding: 40px 32px; text-align: center; margin-bottom: 20px; animation: fadeUp 0.4s ease both; position: relative; overflow: hidden; }
  .hero-card::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent2), var(--accent), transparent); opacity: 0.5; }
  .logo-mark { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 15px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
  .logo-icon { width: 28px; height: 28px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .hero-title { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 400; color: var(--text); margin-bottom: 10px; }
  .hero-title span { color: var(--accent); font-style: italic; }
  .hero-desc { color: var(--muted); font-size: 14px; line-height: 1.6; max-width: 460px; margin: 0 auto 6px; }
  .hero-desc a { color: var(--accent2); text-decoration: none; }
  .hero-desc a:hover { text-decoration: underline; }
  .connected-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(74,158,255,0.12); border: 1px solid rgba(74,158,255,0.25); border-radius: 20px; padding: 5px 12px; font-size: 12px; font-weight: 600; color: var(--accent); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 20px; }
  .connected-badge::before { content: ''; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .connected-body { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 24px; align-items: start; margin-bottom: 8px; }
  @media (max-width: 900px) { .connected-body { grid-template-columns: 1fr; } }
  .connected-stack { display: flex; flex-direction: column; gap: 16px; }
  .connected-sidebar .card { min-height: 0; }
  .connected-pro-wrap .card-full { margin-top: 0; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 24px; animation: fadeUp 0.4s ease both; transition: border-color 0.2s; min-width: 0; display: flex; flex-direction: column; }
  .card:hover { border-color: rgba(255,255,255,0.12); }
  .connected-stack .card:nth-child(1) { animation-delay: 0.05s; } .connected-stack .card:nth-child(2) { animation-delay: 0.08s; } .connected-stack .card:nth-child(3) { animation-delay: 0.11s; } .connected-stack .card:nth-child(4) { animation-delay: 0.14s; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .trial-card { background: linear-gradient(135deg, rgba(124,106,247,0.12), rgba(74,158,255,0.08)); border-color: rgba(124,106,247,0.25); }
  .card-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 12px; }
  .trial-days { font-family: 'Fraunces', serif; font-size: 48px; font-weight: 300; color: var(--accent); line-height: 1; margin-bottom: 4px; }
  .trial-days span { font-size: 18px; color: var(--muted); font-family: 'DM Sans', sans-serif; font-weight: 400; }
  .trial-ends { font-size: 13px; color: var(--muted); margin-bottom: 16px; }
  .trial-bar { height: 4px; background: rgba(255,255,255,0.08); border-radius: 4px; margin-bottom: 16px; overflow: hidden; }
  .trial-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent2), var(--accent)); border-radius: 4px; transition: width 0.3s; }
  .upgrade-link { font-size: 13px; color: var(--muted); padding-top: 12px; }
  .upgrade-link a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .upgrade-link a:hover { text-decoration: underline; }
  .connected-sidebar .card > .connected-msg { margin-top: auto; padding-top: 14px; }
  .connected-sidebar .trial-card .upgrade-link { margin-top: auto; }
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
  .card-full { animation-delay: 0.2s; min-width: 0; width: 100%; }
  .pro-card-header { display: grid; grid-template-columns: 1fr auto; gap: 16px 20px; align-items: center; margin-bottom: 20px; }
  @media (max-width: 600px) { .pro-card-header { grid-template-columns: 1fr; align-items: start; } .pro-stat-badges { flex-direction: row; flex-wrap: wrap; justify-content: flex-start; width: 100%; } }
  .pro-card-intro .card-title { margin-bottom: 8px; }
  .pro-stat-badges { display: flex; flex-direction: column; gap: 8px; align-items: stretch; justify-self: end; }
  .pro-stat-badges .contacts-badge { text-align: left; min-width: 0; max-width: 100%; line-height: 1.35; padding: 8px 12px; font-size: 10px; }
  .contacts-badge { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); background: var(--surface2); padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); }
  .field-specs { background: var(--surface2); border-radius: 12px; padding: 16px 18px; font-size: 13px; color: var(--muted); line-height: 1.65; margin-bottom: 16px; border: 1px solid var(--border); }
  .field-specs strong { color: var(--text); }
  .field-specs code { background: rgba(255,255,255,0.07); border-radius: 4px; padding: 1px 6px; font-size: 12px; color: var(--accent); }
  .field-specs-list { margin: 0; padding-left: 18px; list-style: disc; }
  .field-specs-list li { margin-bottom: 8px; }
  .field-specs-foot { margin: 12px 0 0; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
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
  .pro-customers-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pro-customers-table th, .pro-customers-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  .pro-customers-table th { color: var(--muted); font-weight: 600; }
  .pro-customers-table td { color: var(--text); }
  .manage-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--accent2); font-size: 13px; font-weight: 500; text-decoration: none; transition: color 0.2s; }
  .manage-link:hover { color: #a099f7; }
  .pro-manage-row { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); text-align: center; }
  .manage-link-block { margin-top: 0; justify-content: center; flex-wrap: wrap; text-align: center; }
  .manage-link-sub { color: var(--muted); font-weight: 400; }
  .stars-row { display: flex; gap: 2px; margin-bottom: 6px; }
  .star { color: #f59e0b; font-size: 13px; }
  .connected-msg { margin-top: 8px; font-size: 13px; min-height: 1.4em; }
  .connected-msg.ok { color: #6ee7a3; }
  .connected-msg.err { color: var(--danger); }
  .pro-benefits { margin: 12px 0; padding-left: 20px; font-size: 13px; color: var(--muted); line-height: 1.6; }
  .pro-benefits li { margin-bottom: 6px; }
  .thanks-msg { margin-bottom: 12px; padding: 10px 14px; background: rgba(74,158,255,0.12); border-radius: 10px; color: var(--accent); font-size: 14px; }
  .connected-page-footer { margin-top: 40px; padding-top: 28px; border-top: 1px solid var(--border); text-align: center; font-size: 13px; color: var(--muted); }
  .connected-page-footer a { color: var(--accent2); text-decoration: none; }
  .connected-page-footer a:hover { text-decoration: underline; }
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
  <footer class="connected-page-footer"><a href="/contact">Contact us</a> — questions or concerns?</footer>
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
  const priceLabel = process.env.SUBSCRIBE_PRICE || "$19 / month";
  const proStarterPriceLabel = (process.env.SUBSCRIBE_PRO_STARTER_PRICE || "").trim() || "$39 / month";
  const proGrowthPriceLabel = (process.env.SUBSCRIBE_PRO_GROWTH_PRICE || "").trim() || "$69 / month";
  const proScalePriceLabel = (process.env.SUBSCRIBE_PRO_SCALE_PRICE || "").trim() || "$149 / month";
  const stripeProPriceId = (process.env.STRIPE_PRO_PRICE_ID || "").trim(); // legacy fallback
  const stripeProStarterPriceId = (process.env.STRIPE_PRO_STARTER_PRICE_ID || "").trim();
  const stripeProGrowthPriceId = (process.env.STRIPE_PRO_GROWTH_PRICE_ID || "").trim();
  const stripeProScalePriceId = (process.env.STRIPE_PRO_SCALE_PRICE_ID || "").trim();
  const subscribeProUrl = (process.env.SUBSCRIBE_PRO_URL || "").trim(); // Stripe Payment Link for Replyr Pro (e.g. https://buy.stripe.com/...)
  const hasProPrice = Boolean(stripeProPriceId || stripeProStarterPriceId || stripeProGrowthPriceId || stripeProScalePriceId);
  const hasProPaymentLink = subscribeProUrl.startsWith("http");
  const hasPro = hasProPrice || hasProPaymentLink;
  const billingPortalUrl = (process.env.STRIPE_CUSTOMER_PORTAL_URL || "").trim();
  // Prefer ?accountId= in the URL, but fall back to the signed session cookie.
  // Otherwise a signed-in user who lands on /subscribe directly (no query string)
  // gets treated as anonymous and their checkout doesn't link to their account.
  const queryAccountId =
    (req.query.accountId && String(req.query.accountId).trim()) ||
    (req.query.accountid && String(req.query.accountid).trim()) ||
    "";
  const sessionAccountId = readSessionAccountId(req) || "";
  const accountId = queryAccountId || sessionAccountId;
  const baseCheckoutConfigured = Boolean(process.env.STRIPE_SECRET_KEY && getStripeCorePriceId());
  const subscribeUrlTrim = subscribeUrl.trim();
  const subscribeIsStripePaymentLink = /^https?:\/\/buy\.stripe\.com\//i.test(subscribeUrlTrim);
  const hasStripe =
    baseCheckoutConfigured || subscribeUrlTrim.startsWith("http");
  const hasBillingPortal = billingPortalUrl.startsWith("http");
  // When API Checkout is set up, base plan must use /create-checkout-session (accountId + webhook).
  // Never use buy.stripe.com Payment Links as fallback — they get deactivated ("link is no longer active")
  // and the client used to redirect there after a failed Checkout API call.
  const basePlanNeedsSignIn = baseCheckoutConfigured || subscribeIsStripePaymentLink;
  const ctaHref = baseCheckoutConfigured
    ? "#"
    : subscribeIsStripePaymentLink
      ? "#"
      : subscribeUrlTrim.startsWith("http")
        ? subscribeUrlTrim
        : contact.startsWith("http")
          ? contact
          : contact
            ? "mailto:" + contact
            : "#";
  const ctaText = hasStripe ? "Subscribe to Replyr" : "Contact us to subscribe";
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Subscribe – Replyr</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #7a7880; --danger: #ff6b6b; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; padding: 48px 24px 80px; overflow-x: hidden; }
    body::before { content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%); width: 800px; height: 500px; background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%); pointer-events: none; z-index: 0; }
    .subscribe-page { max-width: 480px; width: 100%; margin: 0 auto; position: relative; z-index: 1; }
    .brand { display: flex; align-items: center; justify-content: center; gap: 9px; margin-bottom: 24px; }
    .brand-icon { width: 30px; height: 30px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; }
    .brand-name { font-size: 16px; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
    h1 { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 300; letter-spacing: -0.02em; color: var(--text); margin: 0 0 8px; text-align: center; }
    h1 em { color: var(--accent); font-style: italic; }
    .tagline { color: var(--muted); font-size: 14px; line-height: 1.6; margin: 0 0 32px; text-align: center; max-width: 380px; margin-left: auto; margin-right: auto; }
    .plan-card { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 28px 28px; margin-bottom: 16px; transition: border-color 0.2s, transform 0.2s; animation: fadeUp 0.4s ease both; }
    .plan-card:hover { border-color: rgba(255,255,255,0.12); transform: translateY(-2px); }
    .plan-card.recommended { border-color: rgba(74,158,255,0.35); background: linear-gradient(135deg, rgba(124,106,247,0.06), rgba(74,158,255,0.04)); }
    .plan-card:nth-child(2) { animation-delay: 0.05s; } .plan-card:nth-child(3) { animation-delay: 0.1s; } .plan-card:nth-child(4) { animation-delay: 0.15s; } .plan-card:nth-child(5) { animation-delay: 0.2s; }
    .recommended-badge { position: absolute; top: -10px; right: 20px; display: inline-flex; align-items: center; gap: 5px; background: linear-gradient(135deg, var(--accent2), var(--accent)); color: #0f0f11; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 5px 11px; border-radius: 999px; box-shadow: 0 4px 14px rgba(74,158,255,0.3); }
    .plan-card h2 { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 400; color: var(--text); margin-bottom: 6px; line-height: 1.2; }
    .plan-desc { color: var(--muted); font-size: 13px; line-height: 1.6; margin-bottom: 16px; }
    .plan-price { font-family: 'Fraunces', serif; font-size: 36px; font-weight: 300; color: var(--text); line-height: 1; margin: 0 0 4px; }
    .plan-price-unit { font-family: 'DM Sans', sans-serif; font-size: 14px; color: var(--muted); font-weight: 400; }
    .plan-price-note { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
    .plan-tagline { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin: 14px 0 14px; }
    .plan-features { list-style: none; margin: 0 0 22px; padding: 0; }
    .plan-features li { position: relative; padding-left: 22px; margin-bottom: 8px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .plan-features li strong { color: var(--text); font-weight: 600; }
    .plan-features li::before { content: ""; position: absolute; left: 0; top: 5px; width: 14px; height: 14px; background: rgba(74,158,255,0.15); border-radius: 50%; }
    .plan-features li::after { content: ""; position: absolute; left: 4px; top: 8px; width: 6px; height: 3px; border-left: 1.5px solid var(--accent); border-bottom: 1.5px solid var(--accent); transform: rotate(-45deg); }
    .cta-wrap { text-align: center; }
    .cta-msg { word-break: break-word; }
    button.cta-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 13px 24px; background: var(--accent); color: #0f0f11; border: none; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-weight: 700; font-size: 14px; cursor: pointer; transition: all 0.2s; width: 100%; letter-spacing: -0.01em; }
    button.cta-btn:hover:not(:disabled) { background: #6bafff; transform: translateY(-1px); box-shadow: 0 8px 30px rgba(74,158,255,0.25); }
    button.cta-btn:disabled { opacity: 0.7; cursor: not-allowed; }
    .plan-card.recommended button.cta-btn { background: linear-gradient(135deg, var(--accent2), var(--accent)); }
    .plan-card.recommended button.cta-btn:hover:not(:disabled) { box-shadow: 0 8px 30px rgba(124,106,247,0.35); }
    .back-row { text-align: center; margin-top: 24px; font-size: 13px; color: var(--muted); }
    .back-row a { color: var(--accent2); text-decoration: none; font-weight: 500; }
    .back-row a:hover { color: #a099f7; text-decoration: underline; }
    .back-row + .back-row { margin-top: 8px; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="subscribe-page" data-account-id="${escapeHtml(accountId)}" data-fallback-url="${escapeHtml(ctaHref)}" data-base-requires-account="${basePlanNeedsSignIn ? "1" : "0"}" data-pro-url="${escapeHtml(subscribeProUrl)}" data-pro-use-checkout="${hasProPrice ? "1" : "0"}">
    <div class="brand">
      <div class="brand-icon" aria-hidden="true">💬</div>
      <span class="brand-name">Replyr</span>
    </div>
    <h1>Choose your <em>plan</em></h1>
    <p class="tagline">Keep auto-reply after your 30-day trial. Cancel anytime from the billing portal.</p>
    <div class="plan-card">
      <h2>Replyr</h2>
      <p class="plan-desc">Automatic, professional replies to every new Google review.</p>
      <p class="plan-price">${escapeHtml(priceLabel)}</p>
      ${hasStripe ? "" : '<p class="plan-price-note">We\'ll send you a secure payment link.</p>'}
      <ul class="plan-features">
        <li>Auto-reply to new <strong>1–5 star</strong> reviews</li>
        <li>Your contact in <strong>1–3 star</strong> replies</li>
        <li>Replies show as <strong>"[Your business] (Owner)"</strong></li>
        <li>Optional <strong>preview mode</strong> for low-star replies</li>
      </ul>
      <div class="cta-wrap">
        <button type="button" id="subscribe-cta" class="cta-btn" data-plan="">${escapeHtml(ctaText)}</button>
        <p id="subscribe-cta-msg" class="cta-msg" style="margin-top:10px;font-size:13px;min-height:1.2em;color:var(--danger);" aria-live="polite"></p>
      </div>
    </div>
    ${hasPro ? `
    <div class="plan-card plan-card-pro">
      <h2>Replyr Pro Starter</h2>
      <p class="plan-desc">For small lists who want a few campaigns a month.</p>
      <p class="plan-price">${escapeHtml(proStarterPriceLabel)}</p>
      <ul class="plan-features">
        <li>Everything in Replyr</li>
        <li>Upload customer CSV (email, name, birthday, phone)</li>
        <li>Automated birthday, event, and one-off campaigns</li>
        <li>Includes up to <strong>500 SMS / month</strong></li>
        <li>Best for <strong>under 1,000 contacts</strong></li>
      </ul>
      <div class="cta-wrap">
        <button type="button" id="subscribe-pro-starter-cta" class="cta-btn" data-plan="pro_starter">Subscribe to Pro Starter</button>
        <p id="subscribe-pro-starter-cta-msg" class="cta-msg" style="margin-top:10px;font-size:13px;min-height:1.2em;color:var(--danger);" aria-live="polite"></p>
      </div>
    </div>
    <div class="plan-card plan-card-pro recommended">
      <span class="recommended-badge">★ Most popular</span>
      <h2>Replyr Pro Growth</h2>
      <p class="plan-desc">For mid-size shops running monthly campaigns.</p>
      <p class="plan-price">${escapeHtml(proGrowthPriceLabel)}</p>
      <ul class="plan-features">
        <li>Everything in Pro Starter</li>
        <li>Includes up to <strong>2,500 SMS / month</strong> (5× Starter)</li>
        <li>Best for <strong>1,000–5,000 contacts</strong></li>
        <li>Multiple monthly events + birthday automations</li>
      </ul>
      <div class="cta-wrap">
        <button type="button" id="subscribe-pro-growth-cta" class="cta-btn" data-plan="pro_growth">Subscribe to Pro Growth</button>
        <p id="subscribe-pro-growth-cta-msg" class="cta-msg" style="margin-top:10px;font-size:13px;min-height:1.2em;color:var(--danger);" aria-live="polite"></p>
      </div>
    </div>
    ${stripeProScalePriceId ? `
    <div class="plan-card plan-card-pro">
      <h2>Replyr Pro Scale</h2>
      <p class="plan-desc">For high-volume businesses with large lists.</p>
      <p class="plan-price">${escapeHtml(proScalePriceLabel)}</p>
      <ul class="plan-features">
        <li>Everything in Pro Growth</li>
        <li>Includes up to <strong>10,000 SMS / month</strong> (4× Growth)</li>
        <li>Best for <strong>5,000+ contacts</strong></li>
        <li>Frequent, multi-channel campaign sends</li>
      </ul>
      <div class="cta-wrap">
        <button type="button" id="subscribe-pro-scale-cta" class="cta-btn" data-plan="pro_scale">Subscribe to Pro Scale</button>
        <p id="subscribe-pro-scale-cta-msg" class="cta-msg" style="margin-top:10px;font-size:13px;min-height:1.2em;color:var(--danger);" aria-live="polite"></p>
      </div>
    </div>` : ""}
` : ""}
    ${hasBillingPortal ? `<p class="back-row"><a href="${escapeHtml(billingPortalUrl)}" target="_blank" rel="noopener">Manage billing / subscription →</a></p>` : ""}
    <p class="back-row"><a href="/">← Back to Replyr</a></p>
    <p class="back-row"><a href="/contact">Contact us</a></p>
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
  var baseRequiresAccount = page.getAttribute("data-base-requires-account") === "1";
  function go(url, openInNewTab, msgEl) {
    if (!url || url === "#" || url.indexOf("http") !== 0) {
      if (msgEl) { msgEl.textContent = "Subscribe link not set up. Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID (or STRIPE_BASE_PRICE_ID) for Checkout."; }
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
  function isProPlan(plan) {
    return !!plan && (plan === "pro" || plan.indexOf("pro_") === 0);
  }
  function bindSubscribe(btn, msgEl, plan) {
    if (!btn) return;
    btn.addEventListener("click", function() {
      if (msgEl) msgEl.textContent = "";
      if (isProPlan(plan) && proUrl && !proUseCheckout) {
        go(proUrl, false, msgEl);
        return;
      }
      if (isProPlan(plan) && proUseCheckout && !accountId) {
        if (msgEl) msgEl.textContent = "Redirecting you to sign in with Google…";
        window.location.href = "/dashboard?return_to=" + encodeURIComponent("/subscribe");
        return;
      }
      if (!accountId && !plan) {
        if (baseRequiresAccount) {
          if (msgEl) msgEl.textContent = "Redirecting you to sign in with Google…";
          window.location.href = "/dashboard?return_to=" + encodeURIComponent("/subscribe");
          return;
        }
        go(fallbackUrl, false, msgEl);
        return;
      }
      btn.disabled = true;
      if (msgEl) msgEl.textContent = "Redirecting to checkout…";
      var body = { accountId: accountId };
      if (plan) body.plan = plan;
      fetch("/create-checkout-session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }).catch(function() { return { ok: false, data: null }; }); }).then(function(result) {
        if (result.data && result.data.url) { go(result.data.url, false, msgEl); return; }
        if (msgEl) {
          msgEl.textContent = (result.data && result.data.error)
            ? result.data.error
            : "Could not start checkout. Try again or contact support.";
        }
      }).catch(function() {
        if (msgEl) msgEl.textContent = "Request failed. Check your connection and try again.";
      }).finally(function() { btn.disabled = false; });
    });
  }
  bindSubscribe(document.getElementById("subscribe-cta"), document.getElementById("subscribe-cta-msg"), "");
  bindSubscribe(document.getElementById("subscribe-pro-starter-cta"), document.getElementById("subscribe-pro-starter-cta-msg"), "pro_starter");
  bindSubscribe(document.getElementById("subscribe-pro-growth-cta"), document.getElementById("subscribe-pro-growth-cta-msg"), "pro_growth");
  bindSubscribe(document.getElementById("subscribe-pro-scale-cta"), document.getElementById("subscribe-pro-scale-cta-msg"), "pro_scale");
})();
`);
});

app.get("/connected.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.send(`
(function() {
  // Keep aria-checked in sync with any role="switch" checkbox.
  document.addEventListener("change", function(e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute("role") === "switch") {
      t.setAttribute("aria-checked", t.checked ? "true" : "false");
    }
  });

  var aidEl = document.querySelector("[data-account-id]");
  var accountId = aidEl ? aidEl.getAttribute("data-account-id") : null;
  var section = document.getElementById("free-reply-section");

  function setFreeReplyVisible(visible) {
    var fr = document.getElementById("free-reply-section");
    if (fr) fr.style.display = visible ? "" : "none";
  }

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
          credentials: "same-origin",
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
            toggle.setAttribute("aria-checked", toggle.checked ? "true" : "false");
          } else {
            autoReplyMsg.textContent = enabled ? "Auto-reply is on." : "Auto-reply is off.";
            autoReplyMsg.classList.add("ok");
            setFreeReplyVisible(!enabled);
          }
        })
        .catch(function() {
          autoReplyMsg.textContent = "Something went wrong.";
          autoReplyMsg.classList.remove("ok"); autoReplyMsg.classList.add("err");
          toggle.checked = !enabled;
          toggle.setAttribute("aria-checked", toggle.checked ? "true" : "false");
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
        credentials: "same-origin",
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
    function isValidContact(v) {
      if (!v) return true; // empty = clear field, allowed
      if (EMAIL_RE.test(v)) return true;
      // Phone: at least 7 digits among the input. Allows "(425) 643-9327" etc.
      var digits = v.replace(/\\D+/g, "");
      return digits.length >= 7 && digits.length <= 15;
    }
    if (aid && contactInput && contactSaveBtn && contactMsg) {
      contactSaveBtn.addEventListener("click", function() {
        var contact = contactInput.value.trim();
        if (!isValidContact(contact)) {
          contactMsg.textContent = "Please enter a valid email address or phone number.";
          contactMsg.classList.remove("ok"); contactMsg.classList.add("err");
          return;
        }
        contactSaveBtn.disabled = true;
        contactMsg.textContent = "";
        contactMsg.classList.remove("ok", "err");
        fetch("/businesses/" + encodeURIComponent(aid), {
          method: "PATCH",
          credentials: "same-origin",
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
              contactMsg.textContent = contact ? "Saved. We'll use this for 1–3 star replies." : "Cleared. Replies won't include a contact.";
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

  // Reply preview mode toggle + notification email
  var previewSection = document.querySelector(".reply-preview-section");
  // Simple, permissive email regex — server is the source of truth.
  var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  function setEmailRowVisible(visible) {
    var row = document.getElementById("notification-email-row");
    if (row) row.style.display = visible ? "flex" : "none";
  }
  if (previewSection) {
    var previewAccountId = previewSection.getAttribute("data-account-id") || accountId;
    var previewToggle = document.getElementById("reply-preview-toggle");
    var previewMsg = document.getElementById("reply-preview-msg");
    var emailInput = document.getElementById("notification-email-input");
    var emailSaveBtn = document.getElementById("notification-email-save-btn");
    function setPreviewMsg(text, kind) {
      if (!previewMsg) return;
      previewMsg.textContent = text || "";
      previewMsg.classList.remove("ok", "err");
      if (kind) previewMsg.classList.add(kind);
    }
    function patchBusiness(payload) {
      return fetch("/businesses/" + encodeURIComponent(previewAccountId), {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); });
    }
    if (previewAccountId && previewToggle) {
      previewToggle.addEventListener("change", function() {
        var nextMode = previewToggle.checked ? "delayed" : "instant";
        setPreviewMsg("");
        setEmailRowVisible(previewToggle.checked);
        patchBusiness({ autoReplyMode: nextMode })
          .then(function(res) {
            if (res.data && res.data.error) {
              setPreviewMsg(res.data.error, "err");
              previewToggle.checked = !previewToggle.checked;
              previewToggle.setAttribute("aria-checked", previewToggle.checked ? "true" : "false");
              setEmailRowVisible(previewToggle.checked);
            } else {
              setPreviewMsg(nextMode === "delayed"
                ? "Preview mode on. We'll email you 15 minutes before low-star replies post."
                : "Preview mode off. Replies post immediately.",
                "ok"
              );
            }
          })
          .catch(function() {
            setPreviewMsg("Something went wrong.", "err");
            previewToggle.checked = !previewToggle.checked;
            previewToggle.setAttribute("aria-checked", previewToggle.checked ? "true" : "false");
            setEmailRowVisible(previewToggle.checked);
          });
      });
    }
    if (previewAccountId && emailSaveBtn && emailInput) {
      emailSaveBtn.addEventListener("click", function() {
        var email = emailInput.value.trim();
        if (email && !EMAIL_RE.test(email)) {
          setPreviewMsg("Please enter a valid email address.", "err");
          return;
        }
        emailSaveBtn.disabled = true;
        setPreviewMsg("");
        patchBusiness({ notificationEmail: email })
          .then(function(res) {
            if (res.data && res.data.error) {
              setPreviewMsg(res.data.error, "err");
            } else {
              setPreviewMsg(email ? "Saved. We'll email " + email + " before low-star replies post." : "Email cleared.", "ok");
            }
          })
          .catch(function() { setPreviewMsg("Something went wrong.", "err"); })
          .finally(function() { emailSaveBtn.disabled = false; });
      });
    }
  }

  // Sync UI from latest server state (handles back button / cached pages)
  fetch("/businesses/" + encodeURIComponent(accountId), { credentials: "same-origin" })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data || data.error) return;
      var t = document.getElementById("auto-reply-toggle");
      if (t) {
        t.checked = !!data.autoReplyEnabled;
        t.setAttribute("aria-checked", t.checked ? "true" : "false");
        t.disabled = !!data.trialEndedNoSubscription;
        setFreeReplyVisible(!t.checked);
      }
      var ci = document.getElementById("contact-input");
      if (ci && data.contact !== undefined && data.contact !== null) ci.value = String(data.contact);
      var pt = document.getElementById("reply-preview-toggle");
      if (pt) {
        pt.checked = data.autoReplyMode === "delayed";
        pt.setAttribute("aria-checked", pt.checked ? "true" : "false");
        setEmailRowVisible(pt.checked);
      }
      var ne = document.getElementById("notification-email-input");
      if (ne && data.notificationEmail != null) ne.value = String(data.notificationEmail || "");
    })
    .catch(function() {});

  // Pro contacts: load count, preview/mapping, upload (only when business has Pro)
  var proSection = document.getElementById("pro-contacts-section");
  var isPro = proSection && proSection.getAttribute("data-is-pro") === "1";
  if (proSection && accountId && isPro) {
    var proCountEl = document.getElementById("pro-contacts-count");
    var proSmsUsageBadge = document.getElementById("pro-sms-usage-badge");
    var proSmsUsageMsg = document.getElementById("pro-sms-usage-msg");
    var proUploadBtn = document.getElementById("pro-upload-btn");
    var proCsvInput = document.getElementById("pro-csv-input");
    var proUploadMsg = document.getElementById("pro-upload-msg");
    var proMappingWrap = document.getElementById("pro-mapping-wrap");
    var proMapEmail = document.getElementById("pro-map-email");
    function showProCount(total, unsubscribed, withEmail) {
      if (!proCountEl) return;
      if (total === 0) proCountEl.textContent = "No contacts yet. Upload a CSV to get started.";
      else {
        var t = total + " contact" + (total === 1 ? "" : "s");
        if (withEmail != null && withEmail !== total) t += " (" + withEmail + " with email)";
        if (unsubscribed > 0) t += " · " + unsubscribed + " unsubscribed";
        proCountEl.textContent = t;
      }
    }
    function showSmsUsage(usage) {
      if (!proSmsUsageBadge) return;
      if (!usage || usage.error) {
        proSmsUsageBadge.textContent = "SMS this month: --/--";
        return;
      }
      var used = Number(usage.usedSms || 0);
      var included = Number(usage.includedSms || 0);
      var remaining = Number(usage.remainingSms || 0);
      var pct = included > 0 ? (used / included) : 0;
      proSmsUsageBadge.textContent = "SMS this month: " + used + "/" + included + " (" + usage.tier + ")";
      if (!proSmsUsageMsg) return;
      proSmsUsageMsg.classList.remove("ok", "err");
      if (pct >= 1) {
        proSmsUsageMsg.textContent = "Monthly SMS limit reached. SMS sends are paused until next month or tier upgrade.";
        proSmsUsageMsg.classList.add("err");
      } else if (pct >= 0.8) {
        proSmsUsageMsg.textContent = "You are at " + Math.round(pct * 100) + "% of monthly SMS (" + remaining + " remaining).";
      } else {
        proSmsUsageMsg.textContent = "SMS remaining this month: " + remaining + ".";
        proSmsUsageMsg.classList.add("ok");
      }
    }
    function loadSmsUsage() {
      fetch("/pro/sms-usage?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
        .then(function(r) { return r.json(); })
        .then(function(data) { showSmsUsage(data); })
        .catch(function() { showSmsUsage(null); });
    }
    fetch("/pro/contacts?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) return;
        showProCount(data.total || 0, data.unsubscribed || 0, data.withEmail);
      })
      .catch(function() {});
    loadSmsUsage();
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
        fetch("/pro/contacts/preview", { method: "POST", credentials: "same-origin", body: fd })
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
      var proUploadBtnOrig = proUploadBtn.innerHTML;
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
        proUploadBtn.innerHTML = proUploadBtnOrig.replace(/Upload CSV/g, "Loading…");
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
        fetch("/pro/contacts/upload", { method: "POST", credentials: "same-origin", body: fd })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.ok) {
              proUploadBtn.innerHTML = proUploadBtnOrig.replace(/Upload CSV/g, "Done!");
              proUploadMsg.textContent = data.message || "Upload complete.";
              proUploadMsg.classList.remove("err"); proUploadMsg.classList.add("ok");
              proCsvInput.value = "";
              if (proMappingWrap) proMappingWrap.style.display = "none";
              fetch("/pro/contacts?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
                .then(function(r2) { return r2.json(); })
                .then(function(c) { if (!c.error) showProCount(c.total || 0, c.unsubscribed || 0, c.withEmail); })
                .catch(function() { showProCount(data.total || data.imported || 0, 0, data.withEmail); });
              loadSmsUsage();
              setTimeout(function() { proUploadBtn.innerHTML = proUploadBtnOrig; proUploadBtn.disabled = false; }, 1500);
            } else {
              proUploadMsg.textContent = data.error || "Upload failed.";
              proUploadMsg.classList.remove("ok"); proUploadMsg.classList.add("err");
              proUploadBtn.innerHTML = proUploadBtnOrig;
              proUploadBtn.disabled = false;
            }
          })
          .catch(function() {
            proUploadMsg.textContent = "Upload failed. Try again.";
            proUploadMsg.classList.remove("ok"); proUploadMsg.classList.add("err");
            proUploadBtn.innerHTML = proUploadBtnOrig;
            proUploadBtn.disabled = false;
          });
      });
    }
    var proViewBtn = document.getElementById("pro-view-customers-btn");
    var proListWrap = document.getElementById("pro-customers-list-wrap");
    var proListTbody = document.getElementById("pro-customers-tbody");
    var proListPagination = document.getElementById("pro-customers-pagination");
    var proListOffset = 0;
    var proListLimit = 50;
    function loadProCustomersList(offset) {
      if (!accountId || !proListTbody) return;
      proListOffset = offset || 0;
      fetch("/pro/contacts/list?accountId=" + encodeURIComponent(accountId) + "&limit=" + proListLimit + "&offset=" + proListOffset, { credentials: "same-origin" })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) return;
          if (proListWrap) proListWrap.style.display = "block";
          proListTbody.innerHTML = (data.list || []).map(function(c) {
            return "<tr><td>" + (c.email || "—") + "</td><td>" + (c.first_name || "—") + "</td><td>" + (c.birthday || "—") + "</td><td>" + (c.phone || "—") + "</td><td>" + (c.unsubscribed ? "Unsubscribed" : "—") + "</td></tr>";
          }).join("");
          var total = data.total || 0;
          var from = total ? proListOffset + 1 : 0;
          var to = Math.min(proListOffset + proListLimit, total);
          if (proListPagination) {
            proListPagination.innerHTML = "Showing " + from + "–" + to + " of " + total + ".";
            if (total > proListLimit) {
              var prevBtn = proListOffset > 0 ? '<button type="button" class="btn btn-ghost" style="font-size:12px;margin-right:8px" id="pro-customers-prev">Previous</button>' : "";
              var nextBtn = proListOffset + proListLimit < total ? '<button type="button" class="btn btn-ghost" style="font-size:12px" id="pro-customers-next">Next</button>' : "";
              proListPagination.innerHTML += " " + prevBtn + nextBtn;
              var prevEl = document.getElementById("pro-customers-prev");
              var nextEl = document.getElementById("pro-customers-next");
              if (prevEl) prevEl.onclick = function() { loadProCustomersList(proListOffset - proListLimit); };
              if (nextEl) nextEl.onclick = function() { loadProCustomersList(proListOffset + proListLimit); };
            }
          }
        })
        .catch(function() {});
    }
    if (proViewBtn) {
      proViewBtn.onclick = function() {
        if (proListWrap && proListWrap.style.display === "none") loadProCustomersList(0);
        else if (proListWrap) { proListWrap.style.display = proListWrap.style.display === "none" ? "block" : "none"; }
      };
    }
  }
})();
  `);
});
function escapeHtml(s) {
  const d = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return String(s).replace(/[&<>"]/g, (c) => d[c]);
}

// Shared dark-brand shell for the simple static-style pages
// (no-business, contact, compliance, privacy, terms).
// Body content is rendered inside .doc-card.
function darkShellHtml({ title, bodyHtml, narrow = false, description = "" }) {
  const pageWidth = narrow ? "440px" : "720px";
  const descMeta = description
    ? `<meta name="description" content="${escapeHtml(description)}">`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
${descMeta}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #7a7880; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; padding: 48px 24px 80px; overflow-x: hidden; line-height: 1.6; }
  body::before { content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%); width: 800px; height: 500px; background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%); pointer-events: none; z-index: 0; }
  .doc-wrap { max-width: ${pageWidth}; margin: 0 auto; position: relative; z-index: 1; }
  .doc-brand { display: flex; align-items: center; justify-content: center; gap: 9px; margin-bottom: 24px; }
  .doc-brand-icon { width: 30px; height: 30px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; }
  .doc-brand-name { font-size: 16px; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
  .doc-card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 32px; animation: fadeUp 0.4s ease both; }
  .doc-card h1 { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 300; letter-spacing: -0.02em; color: var(--text); margin-bottom: 16px; line-height: 1.15; }
  .doc-card h1 em { color: var(--accent); font-style: italic; }
  .doc-card h2 { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 400; color: var(--text); margin: 24px 0 10px; }
  .doc-card p { color: var(--muted); font-size: 14px; line-height: 1.7; margin-bottom: 14px; }
  .doc-card p strong { color: var(--text); font-weight: 600; }
  .doc-card a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .doc-card a:hover { color: #a099f7; text-decoration: underline; }
  .doc-card code { background: rgba(255,255,255,0.06); border-radius: 4px; padding: 1px 6px; font-size: 12px; color: var(--accent); font-family: ui-monospace, SFMono-Regular, monospace; }
  .doc-card .meta-stamp { color: var(--muted); font-size: 12px; margin-bottom: 18px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; }
  .doc-card .callout { background: var(--surface2); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin: 12px 0; }
  .doc-card .callout p:last-child { margin-bottom: 0; }
  .doc-card .callout strong { color: var(--text); }
  .doc-back { text-align: center; margin-top: 24px; font-size: 13px; color: var(--muted); }
  .doc-back a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .doc-back a:hover { color: #a099f7; text-decoration: underline; }
  .doc-btn { display: inline-flex; align-items: center; gap: 7px; margin-top: 6px; padding: 11px 20px; background: var(--accent); color: #0f0f11; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; transition: all 0.2s; }
  .doc-btn:hover { background: #6bafff; transform: translateY(-1px); box-shadow: 0 8px 30px rgba(74,158,255,0.25); color: #0f0f11; text-decoration: none; }
  .doc-card .contact-link { display: inline-block; margin-top: 4px; font-size: 16px; font-weight: 600; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<div class="doc-wrap">
  <div class="doc-brand">
    <div class="doc-brand-icon" aria-hidden="true">💬</div>
    <span class="doc-brand-name">Replyr</span>
  </div>
  <div class="doc-card">
${bodyHtml}
  </div>
</div>
</body>
</html>`;
}

// Shared base CSS for /admin and /admin/metrics. Same dark brand as the rest of
// the app, but a wider wrapper than darkShellHtml since admin tables need room.
function adminBaseCss() {
  return `
  :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #7a7880; --danger: #ff6b6b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; min-height: 100vh; padding: 32px 24px 80px; overflow-x: hidden; line-height: 1.55; }
  body::before { content: ''; position: fixed; top: -200px; left: 50%; transform: translateX(-50%); width: 800px; height: 500px; background: radial-gradient(ellipse, rgba(124,106,247,0.12) 0%, transparent 70%); pointer-events: none; z-index: 0; }
  .admin-wrap { max-width: 1280px; margin: 0 auto; position: relative; z-index: 1; }
  .admin-nav { display: flex; align-items: center; gap: 18px; margin-bottom: 32px; flex-wrap: wrap; }
  .admin-brand { display: inline-flex; align-items: center; gap: 9px; text-decoration: none; color: var(--text); }
  .admin-brand-icon { width: 28px; height: 28px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .admin-brand-name { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
  .admin-tabs { display: inline-flex; gap: 4px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
  .admin-tab { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; transition: all 0.18s; }
  .admin-tab:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .admin-tab.active { color: var(--text); background: linear-gradient(135deg, rgba(124,106,247,0.18), rgba(74,158,255,0.14)); border: 1px solid rgba(124,106,247,0.35); padding: 6px 13px; }
  .admin-page { animation: fadeUp 0.4s ease both; }
  .admin-header { margin-bottom: 24px; }
  .admin-header h1 { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 300; letter-spacing: -0.02em; line-height: 1.1; margin-bottom: 6px; }
  .admin-header h1 em { color: var(--accent); font-style: italic; }
  .admin-subtitle { color: var(--muted); font-size: 13px; max-width: 720px; line-height: 1.6; margin-bottom: 12px; }
  .admin-subtitle strong { color: var(--text); font-weight: 600; }
  .admin-tools { font-size: 13px; color: var(--muted); }
  .admin-tools a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .admin-tools a:hover { color: #a099f7; text-decoration: underline; }
  code { background: rgba(255,255,255,0.06); border-radius: 4px; padding: 1px 6px; font-size: 12px; color: var(--accent); font-family: ui-monospace, SFMono-Regular, monospace; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  `;
}

// Shared top nav for /admin and /admin/metrics. activeTab is "businesses" or
// "metrics" — controls which tab pill is highlighted.
function adminNavHtml(activeTab, encodedSecret) {
  const s = encodedSecret || "";
  const cls = (id) => `admin-tab${activeTab === id ? " active" : ""}`;
  return `<nav class="admin-nav" aria-label="Admin">
      <a href="/admin?secret=${s}" class="admin-brand">
        <span class="admin-brand-icon" aria-hidden="true">💬</span>
        <span class="admin-brand-name">Replyr admin</span>
      </a>
      <div class="admin-tabs" role="tablist">
        <a href="/admin?secret=${s}" class="${cls("businesses")}" role="tab" aria-selected="${activeTab === "businesses"}">Businesses</a>
        <a href="/admin/metrics?secret=${s}" class="${cls("metrics")}" role="tab" aria-selected="${activeTab === "metrics"}">Metrics</a>
      </div>
    </nav>`;
}

app.get("/auth/google", authRouteLimiter, async (req, res, next) => {
  try {
    const returnToRaw = (req.query.return_to && String(req.query.return_to).trim()) || "";
    const returnTo = returnToRaw.startsWith("/") && !returnToRaw.startsWith("//") ? returnToRaw : null;
    const url = await getAuthUrl({ returnTo });
    res.redirect(url);
  } catch (err) {
    req.log.error(err, "Failed to get Google auth URL");
    next(err);
  }
});

app.get("/auth/google/callback", authRouteLimiter, async (req, res, next) => {
  try {
    const code = req.query.code;
    const state = req.query.state;
    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }
    const stateResult = validateState(state?.toString());
    if (!stateResult.ok) {
      return res.status(400).json({ error: "Invalid or expired OAuth state. Please try connecting again." });
    }
    let accountId, accountName, ownerEmail;
    try {
      const result = await handleOAuthCallback(code.toString());
      accountId = result.accountId;
      accountName = result.accountName;
      ownerEmail = result.email || null;
    } catch (err) {
      if (err.message && err.message.includes("No Google Business accounts")) {
        return res.redirect("/no-business?" + new URLSearchParams({ reason: "no_account" }).toString());
      }
      throw err;
    }
    const locations = await listLocations(accountId);
    if (!locations || locations.length === 0) {
      return res.redirect("/no-business?" + new URLSearchParams({ reason: "no_location", accountId }).toString());
    }
    if (locations.length > 1) {
      // Multi-location accounts go through the picker; email auto-fill skipped
      // here (the row doesn't exist yet). Owner can still set it on /connected.
      const t = signChooseLocationToken(accountId);
      return res.redirect("/auth/choose-location?t=" + encodeURIComponent(t));
    }
    const firstLocation = locations[0];
    const locationId = firstLocation?.name ? firstLocation.name.split("/").pop() : null;
    const name = firstLocation?.title || accountName || null;
    await upsertBusiness({
      accountId,
      locationId: locationId || "",
      name
    });
    if (ownerEmail) {
      try {
        await setNotificationEmailIfEmpty(accountId, ownerEmail);
      } catch (err) {
        req.log?.warn(err, "OAuth email auto-fill failed");
      }
    }
    setSessionCookie(res, accountId);
    const redirectName = name || "your business";
    let redirectPath =
      "/connected?name=" + encodeURIComponent(redirectName) + "&accountId=" + encodeURIComponent(accountId);
    if (stateResult.returnTo && String(stateResult.returnTo).trim().startsWith("/")) {
      redirectPath = String(stateResult.returnTo).trim();
    }
    res.redirect(redirectPath);
  } catch (err) {
    req.log.error(err, "OAuth callback failed");
    next(err);
  }
});

// Pick Google Business location when the account has more than one (after OAuth, before session is fully established)
app.get("/auth/choose-location", authRouteLimiter, async (req, res, next) => {
  try {
    const t = (req.query.t && String(req.query.t)) || "";
    const accountId = verifyChooseLocationToken(t);
    if (!accountId) {
      return res.status(400).send("Invalid or expired link. Please connect again from the signup page.");
    }
    const locations = await listLocations(accountId);
    if (!locations.length) {
      return res.redirect("/no-business?" + new URLSearchParams({ reason: "no_location", accountId }).toString());
    }
    if (locations.length === 1) {
      const loc = locations[0];
      const locationId = loc?.name ? loc.name.split("/").pop() : "";
      const name = loc?.title || "";
      await upsertBusiness({ accountId, locationId, name });
      setSessionCookie(res, accountId);
      return res.redirect(
        "/connected?name=" + encodeURIComponent(name || "your business") + "&accountId=" + encodeURIComponent(accountId)
      );
    }
    const options = locations
      .map((loc) => {
        const id = loc?.name ? loc.name.split("/").pop() : "";
        const title = escapeHtml(loc?.title || id || "Location");
        return `<label class="pick-row"><input type="radio" name="locationId" value="${escapeHtml(id)}" required> <span>${title}</span></label>`;
      })
      .join("");
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replyr – Choose location</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 520px; margin: 2rem auto; padding: 1rem; background: #f5f5f5; }
  .card { background: #fff; padding: 1.5rem; border-radius: 12px; box-shadow: 0 1px 8px rgba(0,0,0,0.06); }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; }
  .pick-row { display: block; margin: 0.5rem 0; cursor: pointer; }
  button { margin-top: 1rem; padding: 0.6rem 1.2rem; background: #333; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; }
</style></head>
<body><div class="card">
  <h1>Which location should Replyr use?</h1>
  <p style="color:#555;font-size:14px">Your Google account has multiple business locations. Pick one to connect.</p>
  <form method="post" action="/auth/choose-location">
    <input type="hidden" name="t" value="${escapeHtml(t)}">
    ${options}
    <button type="submit">Continue</button>
  </form>
</div></body></html>`);
  } catch (err) {
    next(err);
  }
});

app.post("/auth/choose-location", authRouteLimiter, express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const t = (req.body?.t && String(req.body.t)) || "";
    const locationId = (req.body?.locationId && String(req.body.locationId).trim()) || "";
    const accountId = verifyChooseLocationToken(t);
    if (!accountId || !locationId) {
      return res.status(400).send("Invalid request. Please start again from the signup page.");
    }
    const locations = await listLocations(accountId);
    const allowed = new Set(
      locations.map((loc) => (loc?.name ? loc.name.split("/").pop() : "")).filter(Boolean)
    );
    if (!allowed.has(locationId)) {
      return res.status(400).send("That location is not available. Please try again.");
    }
    const picked = locations.find((loc) => (loc?.name ? loc.name.split("/").pop() : "") === locationId);
    const name = picked?.title || "";
    await upsertBusiness({ accountId, locationId, name });
    setSessionCookie(res, accountId);
    res.redirect(
      "/connected?name=" + encodeURIComponent(name || "your business") + "&accountId=" + encodeURIComponent(accountId)
    );
  } catch (err) {
    next(err);
  }
});

app.get("/me/google", async (req, res, next) => {
  try {
    const q = (req.query.accountId && String(req.query.accountId).trim()) || "";
    if (!q) {
      return res.status(400).json({ error: "accountId is required" });
    }
    if (!canAccessAccount(req, q)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const status = await getTokenStatus(q);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

app.post("/free-reply", freeReplyLimiter, async (req, res, next) => {
  try {
    const { accountId } = req.body || {};
    if (!accountId || typeof accountId !== "string") {
      return res.status(400).json({ error: "accountId is required" });
    }
    if (!canAccessAccount(req, accountId)) {
      return res.status(403).json({ error: "Forbidden" });
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
    if (isValidAdminRequest(req)) {
      const list = await getAllBusinesses();
      const businesses = Object.values(list).map((b) => ({
        ...b,
        gratisAccess: isGratisAccount(b.accountId)
      }));
      return res.json(businesses);
    }
    const sessionAccount = readSessionAccountId(req);
    if (!sessionAccount) {
      return res.status(401).json({ error: "Sign in required" });
    }
    const business = await getBusiness(sessionAccount);
    if (!business) {
      return res.json([]);
    }
    res.json([
      {
        ...business,
        gratisAccess: isGratisAccount(business.accountId)
      }
    ]);
  } catch (err) {
    next(err);
  }
});

app.get("/businesses/:accountId", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    if (!canAccessAccount(req, accountId)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const business = await getBusiness(accountId);
    if (!business) {
      return res.status(404).json({ error: "Business not found. Connect via /auth/google first." });
    }
    const trialEnded =
      business.trialEndsAt && new Date(business.trialEndsAt) < new Date();
    const gratis = isGratisAccount(accountId);
    const trialEndedNoSubscription =
      !gratis && trialEnded && !business.subscribedAt && !business.isPro;
    res.json({
      ...business,
      trialEndedNoSubscription: !!trialEndedNoSubscription,
      gratisAccess: gratis
    });
  } catch (err) {
    next(err);
  }
});

app.patch("/businesses/:accountId", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    if (!canAccessAccount(req, accountId)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const existing = await getBusiness(accountId);
    if (!existing) {
      return res.status(404).json({ error: "Business not found. Connect via /auth/google first." });
    }
    const { autoReplyEnabled, contact, intervalMinutes, isPro, proTier, autoReplyMode, notificationEmail } = req.body || {};
    const admin = isValidAdminRequest(req);
    const nextIsPro =
      admin && typeof isPro === "boolean" ? !!isPro : !!existing.isPro;
    if (autoReplyEnabled === true) {
      const trialEnded =
        existing.trialEndsAt && new Date(existing.trialEndsAt) < new Date();
      if (
        trialEnded &&
        !existing.subscribedAt &&
        !isGratisAccount(accountId) &&
        !nextIsPro
      ) {
        return res.status(403).json({
          error: "Trial ended. Subscribe to re-enable auto-reply.",
          code: "TRIAL_ENDED"
        });
      }
    }
    const proPatch = {};
    if (admin && typeof isPro === "boolean") proPatch.isPro = !!isPro;
    if (admin && proTier !== undefined) proPatch.proTier = normalizeProTier(proTier);

    // Auto-reply preview mode + notification email validation
    const modePatch = {};
    if (autoReplyMode !== undefined) {
      const next = String(autoReplyMode).trim().toLowerCase();
      if (next !== "instant" && next !== "delayed") {
        return res.status(400).json({ error: "autoReplyMode must be 'instant' or 'delayed'" });
      }
      modePatch.autoReplyMode = next;
    }
    if (notificationEmail !== undefined) {
      const raw = notificationEmail == null ? "" : String(notificationEmail).trim();
      if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        return res.status(400).json({ error: "notificationEmail is not a valid email address" });
      }
      modePatch.notificationEmail = raw || null;
    }
    // Guard: enabling delayed mode requires a notification email (resulting state).
    const willBeDelayed =
      (modePatch.autoReplyMode ?? existing.autoReplyMode ?? "instant") === "delayed";
    const willHaveEmail =
      modePatch.notificationEmail !== undefined
        ? !!modePatch.notificationEmail
        : !!existing.notificationEmail;
    if (willBeDelayed && !willHaveEmail) {
      return res.status(400).json({
        error: "Delayed mode requires a notification email so we can send you the cancel link.",
        code: "DELAYED_MODE_REQUIRES_EMAIL"
      });
    }

    await upsertBusiness({
      ...existing,
      ...(typeof autoReplyEnabled === "boolean" && { autoReplyEnabled }),
      ...(contact !== undefined && { contact: String(contact) }),
      ...(intervalMinutes !== undefined && { intervalMinutes: Number(intervalMinutes) }),
      ...proPatch,
      ...modePatch
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
    if (!guardBusinessAccess(req, res, accountId)) return;
    const business = await getBusiness(accountId);
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }
    if (!business.isPro) {
      return res.status(403).json({ error: "Replyr Pro required. Upgrade at the Subscribe page." });
    }
    const { total, withEmail, unsubscribed } = await getProContactsCount(accountId);
    res.json({ total, withEmail: withEmail ?? total, unsubscribed });
  } catch (err) {
    next(err);
  }
});

app.get("/pro/contacts/list", async (req, res, next) => {
  try {
    const accountId = (req.query.accountId || "").trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    if (!guardBusinessAccess(req, res, accountId)) return;
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    const list = await getProContactsList(accountId, limit, offset);
    const { total } = await getProContactsCount(accountId);
    res.json({ list, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

app.post("/pro/contacts/preview", proUpload.single("file"), async (req, res, next) => {
  try {
    const accountId = (req.body?.accountId ?? req.query?.accountId ?? "").trim();
    if (accountId) {
      if (!guardBusinessAccess(req, res, accountId)) return;
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
    if (!guardBusinessAccess(req, res, accountId)) return;
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
    const { total, withEmail } = await getProContactsCount(accountId);
    const withEmailNum = withEmail ?? total;
    let message = `Uploaded ${total} contact${total === 1 ? "" : "s"}.`;
    if (total !== withEmailNum) message += ` ${withEmailNum} have email (used for campaigns).`;
    message += " Uploading replaces your current list.";
    res.json({ ok: true, imported: parsed.rows.length, total, withEmail: withEmailNum, message });
  } catch (err) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large (max 5MB)" });
    }
    next(err);
  }
});

// --- Pro campaign API (require isPro and DB) ---
app.get("/pro/sms-usage", async (req, res, next) => {
  try {
    const accountId = (req.query.accountId || "").trim();
    if (!guardBusinessAccess(req, res, accountId)) return;
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const monthKey = getCurrentMonthKey();
    const tier = normalizeProTier(business.proTier);
    const includedSms = getIncludedSmsForTier(tier);
    const usedSms = await db.getProSmsUsage(accountId, monthKey);
    res.json({
      monthKey,
      tier,
      includedSms,
      usedSms,
      remainingSms: Math.max(0, includedSms - usedSms)
    });
  } catch (err) {
    next(err);
  }
});

app.get("/pro/birthday-settings", async (req, res, next) => {
  try {
    const accountId = (req.query.accountId || "").trim();
    if (!guardBusinessAccess(req, res, accountId)) return;
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
    const { accountId, enabled, messageText, offerText, sendEmail, sendSms } = req.body || {};
    if (!guardBusinessAccess(req, res, accountId)) return;
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const updated = await db.setProBirthdaySettings(accountId, { enabled, messageText, offerText, sendEmail, sendSms });
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
    if (!guardBusinessAccess(req, res, accountId)) return;
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const campaign = await db.getProEventCampaign(accountId, key, parseInt(year, 10));
    res.json(campaign || { status: "pending", messageText: "", offerText: "", sendAtLocal: null, confirmedAt: null, sentAt: null });
  } catch (err) {
    next(err);
  }
});

app.patch("/pro/events/:key/:year", async (req, res, next) => {
  try {
    const accountId = (req.body?.accountId || req.query.accountId || "").trim();
    const { key, year } = req.params;
    const { status, messageText, offerText, sendAtLocal, sendEmail, sendSms } = req.body || {};
    if (!guardBusinessAccess(req, res, accountId)) return;
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const eventYear = parseInt(year, 10);
    const normalizedSendAtLocal =
      typeof sendAtLocal === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sendAtLocal.trim())
        ? sendAtLocal.trim()
        : null;
    if (status === "confirmed" && !normalizedSendAtLocal) {
      return res.status(400).json({ error: "sendAtLocal is required in YYYY-MM-DDTHH:mm format (Pacific Time)." });
    }
    await db.upsertProEventCampaign(accountId, key, eventYear, {
      status: status || "pending",
      messageText,
      offerText,
      sendAtLocal: normalizedSendAtLocal,
      sendEmail,
      sendSms,
      confirmedAt: status === "confirmed" ? new Date().toISOString() : null
    });
    const updated = await db.getProEventCampaign(accountId, key, eventYear);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.post("/pro/one-off", aiCampaignLimiter, async (req, res, next) => {
  try {
    const { accountId, sendDate, subject, body, sendEmail, sendSms } = req.body || {};
    if (!accountId || !sendDate || !subject) return res.status(400).json({ error: "accountId, sendDate, subject required" });
    if (!guardBusinessAccess(req, res, accountId)) return;
    const business = await getBusiness(accountId);
    if (!business?.isPro) return res.status(403).json({ error: "Replyr Pro required" });
    if (!db.useDb()) return res.status(503).json({ error: "Database required for campaigns" });
    const campaign = await db.createProOneOffCampaign(accountId, sendDate, subject, body || "", sendEmail !== false, sendSms !== false);
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

app.post("/pro/generate-message", aiCampaignLimiter, async (req, res, next) => {
  try {
    const { accountId, type, eventName, offerText, prompt } = req.body || {};
    if (!guardBusinessAccess(req, res, accountId)) return;
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
    if (!canAccessAccount(req, accountId)) {
      const returnTo = encodeURIComponent(req.originalUrl || `/pro?accountId=${encodeURIComponent(accountId)}`);
      return res.redirect(`/auth/google?return_to=${returnTo}`);
    }
    const business = await getBusiness(accountId);
    if (!business?.isPro) {
      res.redirect("/subscribe?accountId=" + encodeURIComponent(accountId));
      return;
    }
    if (!db.useDb()) {
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.send(darkShellHtml({
        title: "Replyr Pro",
        bodyHtml: `    <h1>Campaigns</h1>
    <p>A database is required for campaigns. Use a PostgreSQL connection in production.</p>
    <p style="margin-top:18px"><a href="/connected?accountId=${encodeURIComponent(accountId)}">← Back to Connected</a></p>`,
        narrow: true
      }));
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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
  #event-detail-prompt { min-height: 110px; }
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
    background: linear-gradient(135deg, rgba(124,106,247,0.18), rgba(74,158,255,0.14));
    color: var(--accent2); border: 1px solid rgba(124,106,247,0.35); margin-bottom: 20px; font-weight: 600;
  }
  .btn-generate:hover { background: linear-gradient(135deg, rgba(124,106,247,0.28), rgba(74,158,255,0.22)); color: var(--text); border-color: rgba(124,106,247,0.55); transform: translateY(-1px); box-shadow: 0 4px 16px rgba(124,106,247,0.2); }
  .btn-generate svg { width: 15px; height: 15px; }
  .btn-generate:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
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
  .channel-toggles { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 12px; }
  .channel-toggles .toggle-row { margin: 0; }
  .event-detail-title { font-family: 'Fraunces', serif; font-size: 18px; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .pro-msg { margin-top: 8px; font-size: 13px; color: var(--muted); }
  .pro-msg.ok { color: #6ee7a3; }
  .pro-msg.err { color: #f87171; }
  /* Tabs across Birthday / Events / One-off — sticky at top of viewport on scroll. */
  .pro-tabs {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 4px; padding: 8px;
    margin: 0 0 20px;
    background: rgba(15, 15, 17, 0.85); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    border: 1px solid var(--border); border-radius: 14px;
  }
  .pro-tab {
    flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    padding: 10px 12px; border: 1px solid transparent; border-radius: 10px;
    background: transparent; color: var(--muted);
    font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; cursor: pointer;
    transition: background 0.18s, color 0.18s, border-color 0.18s; letter-spacing: 0.01em;
  }
  .pro-tab .pro-tab-icon { font-size: 14px; line-height: 1; }
  .pro-tab:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .pro-tab.active {
    color: var(--text);
    background: linear-gradient(135deg, rgba(124,106,247,0.18), rgba(74,158,255,0.14));
    border-color: rgba(124,106,247,0.35);
  }
  .pro-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pro-pane { display: none; }
  .pro-pane.active { display: flex; flex-direction: column; }
  @media (max-width: 500px) { .form-row { grid-template-columns: 1fr; } }
  @media (max-width: 420px) {
    .pro-tab { padding: 9px 8px; font-size: 12px; gap: 5px; }
  }
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
    <p class="compliance-note">By uploading and sending you confirm you have permission to email and text those contacts. We send email to contacts with an address; if SMS is enabled, we also send a short text to contacts with a mobile number (birthday, events, one-off). <a href="/compliance">Compliance →</a></p>
  </div>

  <div class="pro-tabs" role="tablist" aria-label="Campaign type">
    <button type="button" class="pro-tab active" role="tab" aria-selected="true" aria-controls="tab-birthday" data-tab="birthday"><span class="pro-tab-icon">🎂</span>Birthday</button>
    <button type="button" class="pro-tab" role="tab" aria-selected="false" aria-controls="tab-events" data-tab="events"><span class="pro-tab-icon">📅</span>Events</button>
    <button type="button" class="pro-tab" role="tab" aria-selected="false" aria-controls="tab-oneoff" data-tab="oneoff"><span class="pro-tab-icon">⚡</span>One-off</button>
  </div>

  <div class="card pro-pane active" id="tab-birthday" role="tabpanel" aria-labelledby="tab-birthday-btn">
    <div class="card-header">
      <div class="card-icon blue">🎂</div>
      <div>
        <div class="card-title">Birthday messages</div>
        <div class="card-desc">One message used for all birthday messages. Use <code style="color:var(--accent);font-size:12px">{{first_name}}</code> and <code style="color:var(--accent);font-size:12px">{{offer}}</code> — filled automatically from your customer list.</div>
      </div>
    </div>
    <div class="toggle-row">
      <label class="toggle">
        <input type="checkbox" id="birthday-enabled" role="switch" aria-checked="${birthday?.enabled ? "true" : "false"}" aria-label="Enable birthday messages" ${birthday?.enabled ? "checked" : ""}>
        <span class="toggle-track"></span>
      </label>
      <span class="toggle-label">Enable birthday messages</span>
      <span class="toggle-status ${birthday?.enabled ? "" : "off"}" id="toggle-status">${birthday?.enabled ? "Active" : "Off"}</span>
    </div>
    <div class="channel-toggles">
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="birthday-send-email" role="switch" aria-checked="${(birthday?.sendEmail !== false) ? "true" : "false"}" aria-label="Send birthday email" ${(birthday?.sendEmail !== false) ? "checked" : ""}>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send email</span>
      </div>
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="birthday-send-sms" role="switch" aria-checked="${(birthday?.sendSms !== false) ? "true" : "false"}" aria-label="Send birthday SMS when contact has phone" ${(birthday?.sendSms !== false) ? "checked" : ""}>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send SMS (when contact has phone)</span>
      </div>
    </div>
    <p class="field-hint" style="margin-top:0.35rem;margin-bottom:0">SMS uses one segment per recipient: up to 137 characters for your message plus a required “Reply STOP to opt out.” line (160 total).</p>
    <div class="field-group">
      <label class="field-label">Describe your business (optional)</label>
      <input type="text" id="birthday-prompt" placeholder="e.g. Anchovie and Salts is a seafood restaurant in Seattle — tailor the message to that" class="field-input">
      <p class="field-hint">Add a short description so Replyr can tailor the birthday message to your business name and type.</p>
    </div>
    <div class="field-group">
      <label class="field-label">Message</label>
      <textarea id="birthday-message" placeholder="Happy birthday, {{first_name}}! As a thank you, {{offer}}...">${escapeHtml(birthday?.messageText || "")}</textarea>
      <div id="birthday-message-counter" class="sms-counter" style="font-size:12px;margin-top:4px;color:var(--muted)">0 chars · 1 SMS segment</div>
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

  <div class="card pro-pane" id="tab-events" role="tabpanel">
    <div class="card-header">
      <div class="card-icon purple">📅</div>
      <div>
        <div class="card-title">Upcoming events</div>
        <div class="card-desc">Opt in per event. We show the <strong style="color:var(--text)">event date</strong> (the holiday); you choose the <strong style="color:var(--text)">exact send date and time</strong> in Pacific Time. Set message and offer, then Confirm.</div>
      </div>
    </div>
    <div class="events-list" id="events-list"></div>
    <div class="event-detail-panel" id="event-detail-panel">
      <div class="event-detail-title" id="event-detail-title">Event</div>
      <div class="field-group">
        <label class="field-label">Prompt for Replyr (optional)</label>
        <textarea id="event-detail-prompt" placeholder="e.g. Keep it warm and short, mention we're a nail salon, highlight spring colors"></textarea>
        <p class="field-hint">Used only when you click <strong>Generate with Replyr</strong>. Add tone, style, and business context.</p>
      </div>
      <div class="field-group">
        <label class="field-label">Message</label>
        <textarea id="event-detail-message" placeholder="e.g. Happy Easter! {{first_name}}, {{offer}}... Use {{first_name}} and {{offer}}." style="min-height: 160px;"></textarea>
        <div id="event-detail-message-counter" class="sms-counter" style="font-size:12px;margin-top:4px;color:var(--muted)">0 chars · 1 SMS segment</div>
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
        <label class="field-label">When to send (Pacific Time - PST/PDT)</label>
        <input type="datetime-local" id="event-detail-send-at" class="field-input">
        <p class="field-hint">Pick the exact date and time in Pacific Time.</p>
        <p id="event-detail-send-at-tz" class="field-hint" style="margin-top:4px;display:none"></p>
      </div>
      <div class="channel-toggles">
        <div class="toggle-row">
          <label class="toggle">
            <input type="checkbox" id="event-detail-send-email" role="switch" aria-checked="true" aria-label="Send event email" checked>
            <span class="toggle-track"></span>
          </label>
          <span class="toggle-label">Send email</span>
        </div>
        <div class="toggle-row">
          <label class="toggle">
            <input type="checkbox" id="event-detail-send-sms" role="switch" aria-checked="true" aria-label="Send event SMS when contact has phone" checked>
            <span class="toggle-track"></span>
          </label>
          <span class="toggle-label">Send SMS (when contact has phone)</span>
        </div>
      </div>
      <p class="field-hint" style="margin-top:0.35rem;margin-bottom:0">SMS uses one segment per recipient: up to 137 characters for your message plus a required “Reply STOP to opt out.” line (160 total).</p>
      <button type="button" class="btn btn-primary" id="event-detail-save">Save and confirm</button>
      <span id="event-detail-msg" class="pro-msg" aria-live="polite"></span>
    </div>
  </div>

  <div class="card pro-pane" id="tab-oneoff" role="tabpanel">
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
      <div id="oneoff-body-counter" class="sms-counter" style="font-size:12px;margin-top:4px;color:var(--muted)">0 chars · 1 SMS segment</div>
    </div>
    <div class="channel-toggles">
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="oneoff-send-email" role="switch" aria-checked="true" aria-label="Send one-off promo email" checked>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send email</span>
      </div>
      <div class="toggle-row">
        <label class="toggle">
          <input type="checkbox" id="oneoff-send-sms" role="switch" aria-checked="true" aria-label="Send one-off promo SMS when contact has phone" checked>
          <span class="toggle-track"></span>
        </label>
        <span class="toggle-label">Send SMS (when contact has phone)</span>
      </div>
    </div>
    <p class="field-hint" style="margin-top:0.35rem;margin-bottom:0">SMS uses one segment: only the first 137 characters of this body are sent as text (plus “Reply STOP to opt out.”). For long promos, turn off SMS or write a short SMS version.</p>
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
  // Keep aria-checked in sync with any role="switch" checkbox.
  document.addEventListener("change", function(e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute("role") === "switch") {
      t.setAttribute("aria-checked", t.checked ? "true" : "false");
    }
  });

  var app = document.getElementById("pro-app");
  if (!app) return;
  var accountId = (app.getAttribute("data-account-id") || "").trim();
  if (!accountId) return;

  // Tabs — show one campaign type pane at a time, keep selection in URL hash
  // so links like /pro#events deep-link straight to a section.
  (function() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".pro-tab"));
    var panes = Array.prototype.slice.call(document.querySelectorAll(".pro-pane"));
    if (!tabs.length || !panes.length) return;
    function show(name) {
      tabs.forEach(function(t) {
        var match = t.getAttribute("data-tab") === name;
        t.classList.toggle("active", match);
        t.setAttribute("aria-selected", match ? "true" : "false");
        t.setAttribute("tabindex", match ? "0" : "-1");
      });
      panes.forEach(function(p) {
        p.classList.toggle("active", p.id === "tab-" + name);
      });
    }
    var initial = (window.location.hash || "").replace(/^#/, "");
    if (!initial || !document.getElementById("tab-" + initial)) initial = "birthday";
    show(initial);
    tabs.forEach(function(t, i) {
      t.addEventListener("click", function() {
        var name = t.getAttribute("data-tab");
        show(name);
        if (history && history.replaceState) history.replaceState(null, "", "#" + name);
      });
      // Left/Right arrows move between tabs.
      t.addEventListener("keydown", function(e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var next = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
        tabs[next].focus();
        tabs[next].click();
      });
    });
  })();

  // Show the user their local equivalent of the chosen Pacific-Time send time
  // when they're not actually in PT. Florida shop owners should not have to do
  // mental math on every event.
  (function() {
    var sendAtEl = document.getElementById("event-detail-send-at");
    var tzHint = document.getElementById("event-detail-send-at-tz");
    if (!sendAtEl || !tzHint) return;
    var localTz = "";
    try { localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
    if (!localTz || localTz === "America/Los_Angeles") return;

    function ptToUtcMs(localStr) {
      // Input: "YYYY-MM-DDTHH:MM" interpreted as Pacific Time (handles PST/PDT
      // automatically via Intl.DateTimeFormat). Output: UTC ms.
      var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/.exec(localStr);
      if (!m) return null;
      var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
      // Get PT offset for this wall-clock time. We approximate: build a UTC
      // date with the wall-clock numbers, then ask Intl what time those UTC
      // ms render as in LA, and shift by the difference.
      var asUtc = Date.UTC(y, mo - 1, d, h, mi);
      var dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
      });
      var parts = dtf.formatToParts(new Date(asUtc));
      function p(t) { var x = parts.find(function(q) { return q.type === t; }); return x ? +x.value : 0; }
      var laUtc = Date.UTC(p("year"), p("month") - 1, p("day"), p("hour") % 24, p("minute"));
      // diff = how many ms ahead UTC reads vs LA wall-clock at this instant.
      var offsetMs = asUtc - laUtc;
      // Wall-clock-in-LA = asUtc - offsetMs, so the actual UTC moment = asUtc + offsetMs.
      return asUtc + offsetMs;
    }
    function render() {
      var v = sendAtEl.value;
      var utc = ptToUtcMs(v);
      if (utc == null) { tzHint.style.display = "none"; tzHint.textContent = ""; return; }
      var fmt = new Intl.DateTimeFormat(undefined, {
        timeZone: localTz, weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short"
      });
      tzHint.textContent = "In your timezone (" + localTz + "): " + fmt.format(new Date(utc));
      tzHint.style.display = "";
    }
    sendAtEl.addEventListener("input", render);
    sendAtEl.addEventListener("change", render);
    // Render now in case a value was already populated by event-detail load.
    render();
    // Also re-render when the panel becomes visible / a new event is loaded.
    var panel = document.getElementById("event-detail-panel");
    if (panel && typeof MutationObserver !== "undefined") {
      new MutationObserver(render).observe(panel, { attributes: true, attributeFilter: ["class"] });
    }
  })();

  var eventEmoji = { valentines_day: "❤️", presidents_day: "🎩", lunar_new_year: "🧧", easter: "🐣", mothers_day: "🌷", memorial_day: "🎖️", fathers_day: "👔", independence_day: "🇺🇸", labor_day: "📋", halloween: "🎃", thanksgiving: "🦃", black_friday: "🛒", christmas: "🎄", new_year: "⭐" };
  function loadEvents() {
    fetch("/pro/events", { credentials: "same-origin" }).then(function(r) { return r.json(); }).then(function(events) {
      var el = document.getElementById("events-list");
      if (!el) return;
      function fmtDate(iso) {
        try {
          var d = new Date(iso + "T12:00:00");
          return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        } catch (_) { return iso; }
      }
      function defaultSendAtLocal(eventDateIso) {
        if (!eventDateIso || !/^\\d{4}-\\d{2}-\\d{2}$/.test(eventDateIso)) return "";
        // Default to 10:00 local Pacific time on the event date.
        return eventDateIso + "T10:00";
      }
      el.innerHTML = events.slice(0, 14).map(function(ev) {
        var eventDateStr = fmtDate(ev.sendDate);
        var emoji = eventEmoji[ev.key] || "📅";
        var y = ev.sendDate.slice(0, 4);
        return '<div class="event-row" data-key="' + ev.key + '" data-year="' + y + '">' +
          '<div class="event-emoji">' + emoji + '</div>' +
          '<div class="event-info"><div class="event-name">' + ev.name + '</div><div class="event-date">' + eventDateStr + '</div></div>' +
          '<div class="event-actions">' +
          '<button type="button" class="btn btn-confirm event-confirm" data-key="' + ev.key + '" data-year="' + y + '" data-name="' + (ev.name || "").replace(/"/g, "&quot;") + '" data-date="' + eventDateStr.replace(/"/g, "&quot;") + '" data-event-date="' + (ev.sendDate || "") + '">Confirm</button>' +
          '<button type="button" class="btn btn-skip event-skip" data-key="' + ev.key + '" data-year="' + y + '">Skip</button>' +
          '<button type="button" class="btn btn-undo event-undo" data-key="' + ev.key + '" data-year="' + y + '" style="display:none">Undo</button>' +
          '</div></div>';
      }).join("");
      var panel = document.getElementById("event-detail-panel");
      var panelTitle = document.getElementById("event-detail-title");
      var panelMessage = document.getElementById("event-detail-message");
      var panelOffer = document.getElementById("event-detail-offer");
      var panelSendAt = document.getElementById("event-detail-send-at");
      var panelPrompt = document.getElementById("event-detail-prompt");
      var panelMsg = document.getElementById("event-detail-msg");
      el.querySelectorAll(".event-confirm").forEach(function(btn) {
        btn.onclick = function() {
          if (btn.disabled) return;
          var key = btn.getAttribute("data-key");
          var year = btn.getAttribute("data-year");
          var name = btn.getAttribute("data-name") || key.replace(/_/g, " ");
          var dateStr = btn.getAttribute("data-date") || "";
          var eventDateIso = btn.getAttribute("data-event-date") || "";
          panel.dataset.key = key;
          panel.dataset.year = year;
          panel.dataset.eventName = name;
          panel._confirmBtn = btn;
          panelTitle.textContent = name + (dateStr ? " – " + dateStr : "");
          panelMessage.value = "";
          panelMessage.dispatchEvent(new Event("input"));
          panelOffer.value = "";
          if (panelSendAt) panelSendAt.value = defaultSendAtLocal(eventDateIso);
          panelPrompt.value = "";
          panelMsg.textContent = "";
          panel.classList.add("visible");
          var sendEmailEl = document.getElementById("event-detail-send-email");
          var sendSmsEl = document.getElementById("event-detail-send-sms");
          function syncAria(el) { if (el && el.getAttribute("role") === "switch") el.setAttribute("aria-checked", el.checked ? "true" : "false"); }
          if (sendEmailEl) { sendEmailEl.checked = true; syncAria(sendEmailEl); }
          if (sendSmsEl) { sendSmsEl.checked = true; syncAria(sendSmsEl); }
          fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
            .then(function(r) { return r.json(); })
            .then(function(c) {
              if (c && c.messageText) { panelMessage.value = c.messageText; panelMessage.dispatchEvent(new Event("input")); }
              if (c && c.offerText) panelOffer.value = c.offerText;
              if (panelSendAt && c && c.sendAtLocal) panelSendAt.value = c.sendAtLocal;
              if (sendEmailEl && c && c.sendEmail !== undefined) { sendEmailEl.checked = c.sendEmail !== false; syncAria(sendEmailEl); }
              if (sendSmsEl && c && c.sendSms !== undefined) { sendSmsEl.checked = c.sendSms !== false; syncAria(sendSmsEl); }
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
            credentials: "same-origin",
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
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: accountId, status: "pending" })
          }).then(function(r) { return r.json(); }).then(function() {
            if (skipBtn) { skipBtn.textContent = "Skip"; skipBtn.disabled = false; }
            btn.style.display = "none";
          }).catch(function() { alert("Undo failed"); });
        };
      });
      function applyEventRowStatusFromCampaign(row, c) {
        if (!row || !c || c.error) return;
        var confirmBtn = row.querySelector(".event-confirm");
        var skipBtn = row.querySelector(".event-skip");
        var undoBtn = row.querySelector(".event-undo");
        if (!confirmBtn) return;
        if (c.sentAt) {
          confirmBtn.textContent = "Sent";
          confirmBtn.disabled = true;
          confirmBtn.classList.remove("event-edit");
          if (skipBtn) skipBtn.style.display = "none";
          return;
        }
        if (c.status === "confirmed") {
          confirmBtn.textContent = "Edit";
          confirmBtn.classList.add("event-edit");
          confirmBtn.disabled = false;
        }
        if (c.status === "skipped") {
          if (skipBtn) { skipBtn.textContent = "Skipped"; skipBtn.disabled = true; }
          if (undoBtn) undoBtn.style.display = "";
        }
      }
      el.querySelectorAll(".event-row").forEach(function(row) {
        var confirmBtn = row.querySelector(".event-confirm");
        if (!confirmBtn) return;
        var key = confirmBtn.getAttribute("data-key");
        var year = confirmBtn.getAttribute("data-year");
        fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
          .then(function(r) { return r.json().then(function(c) { return { ok: r.ok, c: c }; }); })
          .then(function(x) {
            if (!x.ok) return;
            applyEventRowStatusFromCampaign(row, x.c);
          })
          .catch(function() {});
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
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "event", eventName: eventName, offerText: offerText, prompt: businessPrompt })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var ta = document.getElementById("event-detail-message");
        if (ta && data.messageText) { ta.value = data.messageText; ta.dispatchEvent(new Event("input")); }
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
      var sendAtEl = document.getElementById("event-detail-send-at");
      var sendAtLocal = sendAtEl ? String(sendAtEl.value || "").trim() : "";
      var sendEmailEl = document.getElementById("event-detail-send-email");
      var sendSmsEl = document.getElementById("event-detail-send-sms");
      var sendEmail = sendEmailEl ? sendEmailEl.checked : true;
      var sendSms = sendSmsEl ? sendSmsEl.checked : true;
      var msgEl = document.getElementById("event-detail-msg");
      eventDetailSave.disabled = true;
      if (msgEl) msgEl.textContent = "";
      fetch("/pro/events/" + key + "/" + year + "?accountId=" + encodeURIComponent(accountId), {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, status: "confirmed", messageText: message, offerText: offer, sendAtLocal: sendAtLocal, sendEmail: sendEmail, sendSms: sendSms })
      }).then(function(r) {
        return r.json().catch(function() { return {}; }).then(function(data) { return { ok: r.ok, data: data }; });
      }).then(function(x) {
        if (!x.ok) {
          throw new Error((x.data && x.data.error) || "Save failed.");
        }
        if (msgEl) { msgEl.textContent = "Saved and confirmed."; msgEl.className = "pro-msg ok"; }
        eventDetailPanel.classList.remove("visible");
        if (eventDetailPanel._confirmBtn) {
          eventDetailPanel._confirmBtn.textContent = "Edit";
          eventDetailPanel._confirmBtn.disabled = false;
          eventDetailPanel._confirmBtn.classList.add("event-edit");
        }
      }).catch(function(err) {
        if (msgEl) { msgEl.textContent = (err && err.message) ? err.message : "Save failed."; msgEl.className = "pro-msg err"; }
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
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "birthday", offerText: offerText, prompt: businessPrompt })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var ta = document.getElementById("birthday-message");
        if (ta && data.messageText) { ta.value = data.messageText; ta.dispatchEvent(new Event("input")); }
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
      var sendEmailEl = document.getElementById("birthday-send-email");
      var sendSmsEl = document.getElementById("birthday-send-sms");
      var sendEmail = sendEmailEl ? sendEmailEl.checked : true;
      var sendSms = sendSmsEl ? sendSmsEl.checked : true;
      birthdaySave.disabled = true;
      fetch("/pro/birthday-settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, enabled: enabled, messageText: message, offerText: offer, sendEmail: sendEmail, sendSms: sendSms })
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
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, type: "one_off", prompt: promptText })
      }).then(function(r) { return r.json(); }).then(function(data) {
        var sub = document.getElementById("oneoff-subject");
        var bod = document.getElementById("oneoff-body");
        if (sub && data.subject) sub.value = data.subject;
        if (bod && data.body) { bod.value = data.body; bod.dispatchEvent(new Event("input")); }
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
      var sendEmailEl = document.getElementById("oneoff-send-email");
      var sendSmsEl = document.getElementById("oneoff-send-sms");
      var sendEmail = sendEmailEl ? sendEmailEl.checked : true;
      var sendSms = sendSmsEl ? sendSmsEl.checked : true;
      oneoffSchedule.disabled = true;
      fetch("/pro/one-off", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, sendDate: date, subject: subject, body: body, sendEmail: sendEmail, sendSms: sendSms })
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

  // SMS body budget: 137 chars + 23-char STOP footer = 1 GSM segment (160)
  (function() {
    var SMS_SOFT_WARN = 110;
    var SMS_HARD_CAP = 137;
    var SEG1 = 160;

    function smsSegments(text) {
      var len = text.length;
      if (len === 0) return { chars: 0, segs: 0 };
      if (len <= SEG1) return { chars: len, segs: 1 };
      return { chars: len, segs: Math.ceil(len / 153) };
    }

    function updateCounter(taId, counterId) {
      var ta = document.getElementById(taId);
      var counter = document.getElementById(counterId);
      if (!ta || !counter) return;

      function refresh() {
        var text = ta.value;
        if (text.length > SMS_HARD_CAP) {
          ta.value = text.slice(0, SMS_HARD_CAP);
          text = ta.value;
        }
        var s = smsSegments(text);
        counter.textContent = s.chars + " / " + SMS_HARD_CAP + " chars (your text) + opt-out = 1 SMS (~1¢ per recipient)";
        if (s.chars > SMS_SOFT_WARN) {
          counter.style.color = "#e67e22";
          counter.textContent += " — approaching limit";
        } else {
          counter.style.color = "var(--muted)";
        }
      }
      ta.addEventListener("input", refresh);
      ta.addEventListener("change", refresh);
      refresh();
    }

    updateCounter("birthday-message", "birthday-message-counter");
    updateCounter("event-detail-message", "event-detail-message-counter");
    updateCounter("oneoff-body", "oneoff-body-counter");
  })();

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
      return res.status(400).send(darkShellHtml({
        title: "Invalid link",
        bodyHtml: `    <h1 style="text-align:center">Invalid or <em>expired link</em></h1>
    <p style="text-align:center">This unsubscribe link is invalid or has expired. If you still want to stop emails, contact the business that sent them.</p>`,
        narrow: true
      }));
    }
    const { accountId, email } = decoded;
    await setProContactUnsubscribed(accountId, email);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(darkShellHtml({
      title: "Unsubscribed",
      bodyHtml: `    <h1 style="text-align:center">You're <em>unsubscribed</em></h1>
    <p style="text-align:center">You won't receive further campaign emails from this business via Replyr.</p>`,
      narrow: true
    }));
  } catch (err) {
    next(err);
  }
});

// Contact us – for current and potential users (questions, concerns)
app.get("/contact", (req, res) => {
  const contactEmail = (process.env.ALERT_EMAIL || "").trim();
  const emailHtml = contactEmail
    ? `<p><a href="mailto:${escapeHtml(contactEmail)}" class="contact-link">Email Replyr Pro →</a></p>`
    : "<p style=\"font-size:13px\">Set <code>ALERT_EMAIL</code> in your environment to enable the contact link.</p>";
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(darkShellHtml({
    title: "Replyr – Contact us",
    bodyHtml: `    <h1>Contact <em>us</em></h1>
    <p>Questions or concerns? We're here to help — whether you're already using Replyr or thinking about signing up.</p>
    ${emailHtml}
    <p class="doc-back" style="margin-top:24px;text-align:left"><a href="/">← Back to Replyr</a></p>`,
    narrow: true,
    description: "Get in touch with Replyr — questions, support, or feedback."
  }));
});

// Compliance / acceptable use (linked from Pro UI and email footer). Wording aligned with toll-free use case: marketing/promotional messages.
app.get("/compliance", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  const body = `    <h1>Messaging <em>compliance</em></h1>
    <h2>Opt-in workflow (Web Form)</h2>
    <p>When collecting contact information for <strong>marketing and promotional messages</strong> (birthday offers, holiday promotions, special offers), the business must obtain explicit consent. Example web form workflow:</p>
    <div class="callout">
      <p style="margin-bottom:8px"><strong>Required consent (checkbox or equivalent):</strong></p>
      <p style="font-size:13px">“I agree to receive marketing messages and special offers via email and/or SMS from this business. Message and data rates may apply. Reply STOP to opt out of text messages.”</p>
    </div>
    <p>The collected contacts are then used only for the declared use case: birthday and holiday promotional messaging. Consent is obtained before any messages are sent.</p>
    <h2>Business confirmation</h2>
    <p>By uploading a customer list and sending campaigns through Replyr Pro, the business confirms that each contact has agreed to receive marketing and promotional messages (as above) via web form, in-store signup, or an existing customer relationship where they agreed to hear from the business.</p>
    <p>We do not allow spam. Every campaign email includes an unsubscribe link; every SMS includes instructions to reply STOP. We process opt-outs and do not resend to unsubscribed contacts.</p>
    <p>We include a physical address in campaign footers where required (e.g. CAN-SPAM).</p>
    <p style="margin-top:24px"><a href="/">← Back to Replyr</a> · <a href="/contact">Contact us</a></p>`;
  res.send(darkShellHtml({
    title: "Replyr – Messaging compliance",
    bodyHtml: body,
    description: "Replyr Pro messaging compliance — opt-in workflow, business confirmation, opt-out handling."
  }));
});

// Privacy policy (linked from Google OAuth consent screen)
app.get("/privacy", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  const today = new Date().toISOString().split("T")[0];
  const body = `    <h1>Privacy <em>policy</em></h1>
    <p class="meta-stamp">Last updated: ${escapeHtml(today)}</p>
    <h2>Who we are</h2>
    <p>Replyr (“we”, “us”, “our”) provides an AI-assisted service that helps businesses respond to Google Business Profile reviews.</p>
    <h2>What we collect</h2>
    <p>When you connect your Google account, we store Google OAuth tokens for the Google Business Profile you authorize. For Replyr Pro, we also store customer-list data you upload via CSV (email, name, birthday, and optional phone).</p>
    <h2>How we use information</h2>
    <p>We use stored data to: (1) read reviews from your authorized Google Business location(s), (2) generate replies with an AI model, and (3) send email/SMS campaigns for businesses who subscribe to Replyr Pro.</p>
    <h2>Sharing</h2>
    <p>We share limited information with service providers (e.g. Google APIs, Resend for email sending, Twilio for SMS sending, Stripe for billing, and Anthropic for AI generation) to deliver the service. We do not sell your data.</p>
    <h2>Data retention</h2>
    <p>We retain OAuth tokens and any enabled campaign settings while your business account is active and until you disconnect or cancel your subscriptions. Pro customer uploads are stored for the purpose of running campaigns and can be replaced by uploading a new CSV.</p>
    <h2>Your choices</h2>
    <p>You can disconnect Google access via the app, and you can manage/unsubscribe contacts using the unsubscribe links provided in emails/SMS (Pro campaigns).</p>
    <p style="margin-top:24px"><a href="/">← Back to Replyr</a> · <a href="/contact">Contact us</a></p>`;
  res.send(darkShellHtml({
    title: "Replyr – Privacy policy",
    bodyHtml: body,
    description: "Replyr privacy policy — what we collect, how we use it, and your choices."
  }));
});

// Terms of service (linked from Google OAuth consent screen)
app.get("/terms", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  const today = new Date().toISOString().split("T")[0];
  const body = `    <h1>Terms of <em>service</em></h1>
    <p class="meta-stamp">Last updated: ${escapeHtml(today)}</p>
    <h2>Agreement</h2>
    <p>By using Replyr, you agree to these Terms. Replyr provides an automation and AI-assistance tool; it does not guarantee specific outcomes.</p>
    <h2>Use of service</h2>
    <p>You are responsible for ensuring you have the rights and permissions to send messages to your contacts and for complying with applicable laws (including consent and unsubscribe requirements for promotional messages).</p>
    <h2>No warranty</h2>
    <p>Replyr is provided “as is”. We do not guarantee uninterrupted service, accuracy of AI-generated text, or that replies/campaigns will be delivered.</p>
    <h2>Billing (Stripe)</h2>
    <p>If you subscribe, billing is handled by Stripe according to Stripe terms. Cancellation and refund policies (if any) are governed by Stripe’s policy and your plan.</p>
    <h2>Limitation of liability</h2>
    <p>To the maximum extent permitted by law, Replyr is not liable for indirect, incidental, or consequential damages arising from use of the service.</p>
    <p style="margin-top:24px"><a href="/">← Back to Replyr</a> · <a href="/contact">Contact us</a></p>`;
  res.send(darkShellHtml({
    title: "Replyr – Terms of service",
    bodyHtml: body,
    description: "Replyr terms of service."
  }));
});

// Admin page: list businesses, edit contact and auto-reply (requires ADMIN_SECRET via ?secret= or X-Admin-Secret)
async function buildAdminMetrics() {
  const businessesObj = await getAllBusinesses();
  const businesses = Object.values(businessesObj || {});
  const amounts = getPlanAmountsCents();
  const mrr = computeMrr(businesses, amounts);
  const funnel = computeFunnel(businesses, {
    windowDays: 30,
    isGratis: isGratisAccount
  });
  const monthKey = getCurrentMonthKey();
  const [openPending, smsThisMonth] = await Promise.all([
    db.useDb() ? db.getOpenPendingRepliesCount() : Promise.resolve(0),
    db.useDb() ? db.getProSmsUsageSum(monthKey) : Promise.resolve(0)
  ]);
  const delayedModeCount = businesses.filter((b) => (b.autoReplyMode || "instant") === "delayed").length;
  const autoReplyEnabledCount = businesses.filter((b) => !!b.autoReplyEnabled).length;
  return {
    generatedAt: new Date().toISOString(),
    mrr: {
      totalCents: mrr.mrrCents,
      totalDisplay: formatCentsAsUsd(mrr.mrrCents),
      byPlanCents: mrr.mrrByPlan,
      countsByPlan: mrr.countsByPlan,
      activeSubscribers: mrr.activeSubs
    },
    funnel,
    activity: {
      monthKey,
      autoReplyEnabledCount,
      delayedModeCount,
      pendingRepliesOpen: openPending,
      proSmsThisMonth: smsThisMonth
    },
    planAmountsConfigured: {
      base: amounts.base > 0,
      proStarter: amounts.proStarter > 0,
      proGrowth: amounts.proGrowth > 0,
      proScale: amounts.proScale > 0
    }
  };
}

app.get("/admin/metrics.json", async (req, res, next) => {
  try {
    if (!(process.env.ADMIN_SECRET || "").trim()) {
      return res.status(503).json({ error: "Admin disabled. Set ADMIN_SECRET in the server environment." });
    }
    if (!isValidAdminRequest(req)) {
      return res.status(401).json({ error: "Unauthorized. Provide ADMIN_SECRET via X-Admin-Secret header or ?secret=." });
    }
    const data = await buildAdminMetrics();
    res.json(data);
  } catch (err) {
    req.log?.error(err, "Admin metrics JSON failed");
    next(err);
  }
});

app.get("/admin/metrics", async (req, res, next) => {
  try {
    if (!(process.env.ADMIN_SECRET || "").trim()) {
      res.status(503).set("Content-Type", "text/html; charset=utf-8");
      return res.send(darkShellHtml({
        title: "Replyr – Admin disabled",
        bodyHtml: `    <h1>Admin <em>disabled</em></h1>
    <p>Set <code>ADMIN_SECRET</code> in the server environment to enable admin pages.</p>`,
        narrow: true
      }));
    }
    if (!isValidAdminRequest(req)) {
      res.status(401).set("Content-Type", "text/html; charset=utf-8");
      return res.send(darkShellHtml({
        title: "Replyr – Unauthorized",
        bodyHtml: `    <h1>Unauthorized</h1>
    <p>Add your admin secret to the URL: <code>/admin/metrics?secret=YOUR_ADMIN_SECRET</code> — or send it as the <code>X-Admin-Secret</code> header.</p>`,
        narrow: true
      }));
    }
    const data = await buildAdminMetrics();
    const adminSecret = getAdminSecretFromRequest(req);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(renderAdminMetricsHtml(data, adminSecret));
  } catch (err) {
    req.log?.error(err, "Admin metrics page failed");
    next(err);
  }
});

function renderAdminMetricsHtml(data, adminSecret) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const cents = (c) => formatCentsAsUsd(c);
  const counts = data.mrr.countsByPlan;
  const planRow = (label, key) =>
    `<tr><td>${label}</td><td class="num">${counts[key] || 0}</td><td class="num">${cents(data.mrr.byPlanCents[key] || 0)}</td></tr>`;
  const planConfigWarnings = [
    !data.planAmountsConfigured.base && "STRIPE_BASE_PRICE_AMOUNT_CENTS",
    !data.planAmountsConfigured.proStarter && "STRIPE_PRO_STARTER_AMOUNT_CENTS",
    !data.planAmountsConfigured.proGrowth && "STRIPE_PRO_GROWTH_AMOUNT_CENTS",
    !data.planAmountsConfigured.proScale && "STRIPE_PRO_SCALE_AMOUNT_CENTS"
  ].filter(Boolean);
  const warningHtml = planConfigWarnings.length
    ? `<div class="warn">⚠ MRR may be undercounted — these env vars aren't set: ${planConfigWarnings.map((s) => `<code>${s}</code>`).join(", ")}</div>`
    : "";
  const encodedSecret = encodeURIComponent(adminSecret || "");
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Replyr – Admin metrics</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${adminBaseCss()}</style>
<style>
  .ts { color: var(--muted); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; margin-bottom: 16px; }
  .section-label { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 400; color: var(--text); margin: 28px 0 14px; }
  .section-label:first-of-type { margin-top: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
    padding: 18px 20px; transition: border-color 0.18s, transform 0.18s;
    animation: fadeUp 0.4s ease both;
  }
  .stat-card:hover { border-color: rgba(255,255,255,0.12); transform: translateY(-1px); }
  .stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .stat-value { font-family: 'Fraunces', serif; font-size: 32px; font-weight: 300; color: var(--text); margin-top: 6px; line-height: 1.1; letter-spacing: -0.01em; }
  .stat-sub { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; animation: fadeUp 0.4s ease both; }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    background: var(--surface2); color: var(--muted);
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--border);
  }
  thead th.num, tbody td.num { text-align: right; }
  tbody td { padding: 11px 16px; border-bottom: 1px solid var(--border); font-size: 13px; color: var(--text); }
  tbody tr:last-child td { border-bottom: none; background: rgba(124,106,247,0.04); }
  tbody tr:last-child td strong { color: var(--text); }
  .warn {
    background: linear-gradient(135deg, rgba(245,159,11,0.12), rgba(245,159,11,0.06));
    border: 1px solid rgba(245,159,11,0.35); border-radius: 12px;
    padding: 12px 16px; font-size: 13px; color: #f5a55c; margin-bottom: 18px;
  }
  .warn code { color: #f5a55c; background: rgba(245,159,11,0.15); }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
  .footer a { color: var(--accent2); text-decoration: none; font-weight: 500; }
  .footer a:hover { color: #a099f7; text-decoration: underline; }
</style>
</head>
<body>
<div class="admin-wrap">
  ${adminNavHtml("metrics", encodedSecret)}
  <div class="admin-page">
    <div class="admin-header">
      <h1>Metrics</h1>
      <p class="admin-subtitle">MRR, 30-day funnel, and current activity. MRR is computed locally from the <code>businesses</code> table using <code>STRIPE_*_AMOUNT_CENTS</code> env vars.</p>
      <div class="ts">As of ${escapeHtml(data.generatedAt)}</div>
    </div>

    ${warningHtml}

    <h2 class="section-label">Revenue</h2>
    <div class="grid">
      <div class="stat-card"><div class="stat-label">MRR</div><div class="stat-value">${cents(data.mrr.totalCents)}</div><div class="stat-sub">${data.mrr.activeSubscribers} active subscribers</div></div>
      <div class="stat-card"><div class="stat-label">Conversion (30d)</div><div class="stat-value">${pct(data.funnel.conversionRate)}</div><div class="stat-sub">${data.funnel.trialToPaid} of ${data.funnel.trialsStarted} trials in window</div></div>
      <div class="stat-card"><div class="stat-label">Active trials</div><div class="stat-value">${data.funnel.activeTrial}</div><div class="stat-sub">connected, in trial, not subscribed</div></div>
      <div class="stat-card"><div class="stat-label">Trial-end attrition</div><div class="stat-value">${data.funnel.trialEndedNoSub}</div><div class="stat-sub">trial ended, never subscribed</div></div>
    </div>

    <h2 class="section-label">Plans</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Plan</th><th class="num">Active</th><th class="num">MRR</th></tr></thead>
        <tbody>
          ${planRow("Base Replyr", "base")}
          ${planRow("Pro Starter", "pro_starter")}
          ${planRow("Pro Growth", "pro_growth")}
          ${planRow("Pro Scale", "pro_scale")}
          ${counts.pro_legacy ? planRow("Pro (legacy)", "pro_legacy") : ""}
          <tr><td><strong>Total paid</strong></td><td class="num"><strong>${data.mrr.activeSubscribers}</strong></td><td class="num"><strong>${cents(data.mrr.totalCents)}</strong></td></tr>
        </tbody>
      </table>
    </div>

    <h2 class="section-label">Activity</h2>
    <div class="grid">
      <div class="stat-card"><div class="stat-label">Connected businesses</div><div class="stat-value">${data.funnel.totalConnected}</div></div>
      <div class="stat-card"><div class="stat-label">Auto-reply enabled</div><div class="stat-value">${data.activity.autoReplyEnabledCount}</div></div>
      <div class="stat-card"><div class="stat-label">Preview/delayed mode</div><div class="stat-value">${data.activity.delayedModeCount}</div></div>
      <div class="stat-card"><div class="stat-label">Pending replies queued</div><div class="stat-value">${data.activity.pendingRepliesOpen}</div></div>
      <div class="stat-card"><div class="stat-label">Pro SMS this month</div><div class="stat-value">${data.activity.proSmsThisMonth.toLocaleString()}</div><div class="stat-sub">${escapeHtml(data.activity.monthKey)} · across all Pro tiers</div></div>
    </div>

    <div class="footer">JSON view: <a href="/admin/metrics.json?secret=${encodedSecret}">/admin/metrics.json</a></div>
  </div>
</div>
</body></html>`;
}

app.get("/admin", (req, res) => {
  const adminConfigured = !!(process.env.ADMIN_SECRET || "").trim();
  if (!adminConfigured) {
    res.status(503).set("Content-Type", "text/html; charset=utf-8");
    return res.send(darkShellHtml({
      title: "Replyr – Admin disabled",
      bodyHtml: `    <h1>Admin <em>disabled</em></h1>
    <p>Set <code>ADMIN_SECRET</code> in the server environment, then open <code>/admin?secret=…</code></p>`,
      narrow: true
    }));
  }
  if (!isValidAdminRequest(req)) {
    res.status(401).set("Content-Type", "text/html; charset=utf-8");
    return res.send(darkShellHtml({
      title: "Replyr – Unauthorized",
      bodyHtml: `    <h1>Unauthorized</h1>
    <p>Add your admin secret to the URL: <code>/admin?secret=YOUR_ADMIN_SECRET</code> — or send it as the <code>X-Admin-Secret</code> header.</p>`,
      narrow: true
    }));
  }
  const adminSecretForScript = encodeURIComponent(getAdminSecretFromRequest(req));
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Replyr – Admin</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>${adminBaseCss()}</style>
  <style>
    /* Businesses table — dense, scrolls horizontally if needed */
    .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: auto; animation: fadeUp 0.4s ease both; }
    table { width: 100%; border-collapse: collapse; min-width: 880px; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--surface2); color: var(--muted); font-size: 11px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
      padding: 12px 14px; border-bottom: 1px solid var(--border);
    }
    tbody td { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: rgba(255,255,255,0.02); }
    input[type="text"], input[type="number"], select {
      background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
      color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 13px; padding: 7px 10px;
      transition: border-color 0.18s, box-shadow 0.18s; outline: none; min-width: 0;
    }
    input[type="text"] { width: 100%; }
    input[type="number"] { width: 70px; }
    select { cursor: pointer; }
    input:focus, select:focus { border-color: rgba(74,158,255,0.5); box-shadow: 0 0 0 3px rgba(74,158,255,0.1); }
    input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
    button {
      background: var(--accent); color: #0f0f11; border: none; border-radius: 8px;
      font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600; cursor: pointer;
      padding: 7px 12px; transition: all 0.18s;
    }
    button:hover:not(:disabled) { background: #6bafff; transform: translateY(-1px); }
    button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    button[data-run-now] { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
    button[data-run-now]:hover:not(:disabled) { background: rgba(124,106,247,0.15); color: var(--text); border-color: rgba(124,106,247,0.4); }
    [data-pro-link] { font-size: 12px; color: var(--accent2); text-decoration: none; padding: 6px 10px; border-radius: 8px; transition: background 0.18s; }
    [data-pro-link]:hover { background: rgba(124,106,247,0.12); color: #a099f7; text-decoration: none; }
    .actions-cell { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .msg { display: block; margin-top: 4px; font-size: 11px; min-height: 1em; }
    .msg.ok { color: #6ee7a3; }
    .msg.err { color: var(--danger); }
    .empty {
      background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
      padding: 48px 24px; text-align: center; color: var(--muted); font-size: 14px;
    }
    .filter-row {
      display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px;
    }
    .filter-row label { font-size: 12px; color: var(--muted); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .status-subscribed, .status-trial, .status-expired, .status-gratis, .status-pro {
      display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .status-subscribed { background: rgba(110,231,163,0.15); color: #6ee7a3; }
    .status-trial { background: rgba(74,158,255,0.15); color: var(--accent); }
    .status-expired { background: rgba(255,107,107,0.15); color: var(--danger); }
    .status-gratis { background: rgba(110,231,163,0.15); color: #6ee7a3; }
    .status-pro { background: rgba(124,106,247,0.18); color: #a099f7; }
    .loading { color: var(--muted); padding: 32px 4px; text-align: center; font-size: 14px; }
  </style>
</head>
<body>
  <div class="admin-wrap">
    ${adminNavHtml("businesses", adminSecretForScript)}
    <div class="admin-page">
      <div class="admin-header">
        <h1>Businesses</h1>
        <p class="admin-subtitle">Edit contact, Pro tier, and auto-reply settings per business. Click <strong>Run now</strong> to trigger Claude auto-reply for that business immediately.</p>
        <p class="admin-tools"><a href="/admin" id="admin-refresh-link">Refresh</a> · <a href="/businesses" id="admin-json-link">JSON export</a></p>
      </div>
      <div id="loading" class="loading">Loading businesses…</div>
      <div id="content" style="display: none;">
        <div class="filter-row" id="filter-row" style="display: none;"><label for="status-filter">Status</label><select id="status-filter"><option value="">All</option><option value="trial">Trial</option><option value="subscribed">Subscribed</option><option value="pro">Pro</option><option value="gratis">Complimentary</option><option value="expired">Expired</option></select></div>
      </div>
    </div>
  </div>
  <script src="/admin.js?secret=${adminSecretForScript}"></script>
</body>
</html>
  `);
});

// Admin script (separate so CSP allows it) — secret must match ADMIN_SECRET (query or header)
app.get("/admin.js", (req, res) => {
  if (!(process.env.ADMIN_SECRET || "").trim()) {
    return res.status(404).type("text/plain").send("Not found");
  }
  if (!isValidAdminRequest(req)) {
    return res.status(401).type("text/plain").send("Unauthorized");
  }
  const adminShowProScaleTier = !!(process.env.STRIPE_PRO_SCALE_PRICE_ID || "").trim();
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.send(`
var REPLYR_ADMIN_SECRET = (function() {
  try {
    var sc = document.currentScript && document.currentScript.src;
    if (sc) return new URL(sc).searchParams.get("secret") || "";
  } catch (e) {}
  return new URLSearchParams(location.search).get("secret") || "";
})();
var REPLYR_ADMIN_SHOW_PRO_SCALE = ${JSON.stringify(adminShowProScaleTier)};
function replyrAdminHeaders(json) {
  var h = {};
  if (json) h["Content-Type"] = "application/json";
  if (REPLYR_ADMIN_SECRET) h["X-Admin-Secret"] = REPLYR_ADMIN_SECRET;
  return h;
}
(function initAdminLinks() {
  var s = REPLYR_ADMIN_SECRET;
  if (!s) return;
  var r = document.getElementById("admin-refresh-link");
  if (r) r.href = "/admin?secret=" + encodeURIComponent(s);
  var j = document.getElementById("admin-json-link");
  if (j) {
    j.href = "#";
    j.addEventListener("click", function(e) {
      e.preventDefault();
      fetch("/businesses", { headers: replyrAdminHeaders(false), credentials: "same-origin" })
        .then(function(r2) { return r2.json(); })
        .then(function(data) {
          var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          var u = URL.createObjectURL(blob);
          window.open(u, "_blank");
          setTimeout(function() { URL.revokeObjectURL(u); }, 60000);
        })
        .catch(function() { alert("Failed to load JSON"); });
    });
  }
})();
function proTierSelectInnerHtml(tier) {
  var o = '<option value="starter"' + (tier === "starter" ? " selected" : "") + '>Starter — 500 SMS/mo</option>' +
    '<option value="growth"' + (tier === "growth" ? " selected" : "") + '>Growth — 2,500 SMS/mo</option>';
  if (REPLYR_ADMIN_SHOW_PRO_SCALE || tier === "scale") {
    o += '<option value="scale"' + (tier === "scale" ? " selected" : "") + '>Scale — 10,000 SMS/mo</option>';
  }
  return o;
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
function getStatus(b) {
  if (b.subscribedAt) return { status: "subscribed", label: "Subscribed", className: "status-subscribed" };
  if (b.gratisAccess) return { status: "gratis", label: "Complimentary", className: "status-gratis" };
  if (b.isPro) return { status: "pro", label: "Pro", className: "status-pro" };
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
    const r = await fetch("/businesses", { headers: replyrAdminHeaders(false), credentials: "same-origin" });
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) {
      content.innerHTML = "<p class=\\"empty\\">No businesses yet. Have them connect via the auth link.</p>";
    } else {
      const tableHtml = "<div class=\\"table-wrap\\"><table><thead><tr><th>Name</th><th>Contact (for 1–3 star replies)</th><th>Trial ends</th><th>Status</th><th>Pro</th><th>Pro tier (SMS/mo)</th><th>Auto-reply</th><th>Interval (min)</th><th>Actions</th></tr></thead><tbody></tbody></table></div>";
      content.insertAdjacentHTML("beforeend", tableHtml);
      const tableWrap = content.querySelector(".table-wrap");
      if (filterRow) { content.insertBefore(filterRow, tableWrap); filterRow.style.display = "flex"; }
      const tbody = content.querySelector("tbody");
      list.forEach(b => {
        const s = getStatus(b);
        const trialEndStr = formatTrialEnd(b.trialEndsAt);
        const tr = document.createElement("tr");
        tr.dataset.accountId = b.accountId;
        tr.dataset.locationId = b.locationId || "";
        tr.dataset.status = s.status;
        var tier = String(b.proTier || "starter").toLowerCase();
        if (["starter", "growth", "scale"].indexOf(tier) === -1) tier = "starter";
        tr.innerHTML = "<td>" + escapeHtml(b.name || "—") + "</td>" +
          "<td><input type=\\"text\\" value=\\"" + escapeAttr(b.contact || "") + "\\" data-field=\\"contact\\"></td>" +
          "<td>" + escapeHtml(trialEndStr) + "</td>" +
          "<td><span class=\\"" + s.className + "\\">" + escapeHtml(s.label) + "</span></td>" +
          "<td><input type=\\"checkbox\\" " + (b.isPro ? "checked" : "") + " data-field=\\"isPro\\" title=\\"Pro (campaigns, CSV)\\"></td>" +
          "<td><select data-field=\\"proTier\\" title=\\"Pro campaign SMS allowance (see /subscribe)\\">" + proTierSelectInnerHtml(tier) + "</select></td>" +
          "<td><input type=\\"checkbox\\" " + (b.autoReplyEnabled ? "checked" : "") + " data-field=\\"autoReplyEnabled\\"></td>" +
          "<td><input type=\\"number\\" min=\\"1\\" value=\\""
          + (b.intervalMinutes ?? 30)
          + "\\" data-field=\\"intervalMinutes\\"></td>" +
          "<td><div class=\\"actions-cell\\"><button type=\\"button\\" data-save>Save</button><button type=\\"button\\" data-run-now title=\\"Run Claude auto-reply now\\">Run now</button><a href=\\"#\\" data-pro-link title=\\"Open Pro campaigns page\\">Pro</a></div><span class=\\"msg\\" data-msg></span></td>";
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
  const proTier = tr.querySelector("[data-field=proTier]").value;
  const autoReplyEnabled = tr.querySelector("[data-field=autoReplyEnabled]").checked;
  const intervalMinutes = parseInt(tr.querySelector("[data-field=intervalMinutes]").value, 10) || 30;
  const msgEl = tr.querySelector("[data-msg]");
  msgEl.textContent = "";
  msgEl.className = "msg";
  btn.disabled = true;
  try {
    const r = await fetch("/businesses/" + encodeURIComponent(accountId), {
      method: "PATCH",
      headers: replyrAdminHeaders(true),
      credentials: "same-origin",
      body: JSON.stringify({ contact, isPro, proTier, autoReplyEnabled, intervalMinutes })
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
      headers: replyrAdminHeaders(true),
      credentials: "same-origin",
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
    if (!guardBusinessAccess(req, res, accountId)) return;
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
    const accountId = (req.query.accountId && String(req.query.accountId).trim()) || "";
    if (!guardBusinessAccess(req, res, accountId)) return;
    const accounts = await listAccounts(accountId);
    res.json(accounts);
  } catch (err) {
    req.log.error(err, "Failed to list accounts");
    next(err);
  }
});

app.get("/google/accounts/:accountId/locations", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    if (!guardBusinessAccess(req, res, accountId)) return;
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
    if (!guardBusinessAccess(req, res, accountId)) return;
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
    const usedBody = !!(accountId && locationId);
    if (usedBody) {
      if (!canAccessAccount(req, String(accountId))) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else if (!isValidAdminRequest(req)) {
      return res.status(403).json({ error: "Forbidden" });
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

app.use(sentry.errorHandler());
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

start().catch(async (err) => {
  const dbHint = db.useDb()
    ? " (PostgreSQL: verify DATABASE_URL on this Railway service and that the Postgres service is running)"
    : "";
  logger.fatal(err, `Startup failed${dbHint}`);
  sentry.captureException(err, { kind: "startup" });
  await sentry.flush();
  process.exit(1);
});
