import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";
import { listReviews, replyToReview } from "./google.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, "..", "auto-state.json");

function stateKey(accountId, locationId) {
  return `${accountId}_${locationId}`;
}

async function readAllState() {
  if (db.useDb()) {
    return {};
  }
  try {
    const data = await fs.readFile(STATE_PATH, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function readState(accountId, locationId) {
  if (db.useDb()) {
    return await db.getAutoState(accountId, locationId);
  }
  const all = await readAllState();
  const key = stateKey(accountId, locationId);
  const state = all[key] || { repliedReviewIds: [] };
  return state;
}

async function writeState(accountId, locationId, state) {
  if (db.useDb()) {
    await db.setAutoState(accountId, locationId, state);
    return;
  }
  const all = await readAllState();
  const key = stateKey(accountId, locationId);
  all[key] = state;
  await fs.writeFile(STATE_PATH, JSON.stringify(all, null, 2), "utf8");
}

/** Add a review ID to the replied list (for free-reply or manual). Works with file or DB. */
export async function addRepliedReviewId(accountId, locationId, reviewId) {
  const state = await readState(accountId, locationId);
  state.repliedReviewIds = state.repliedReviewIds || [];
  if (!state.repliedReviewIds.includes(reviewId)) {
    state.repliedReviewIds.push(reviewId);
    await writeState(accountId, locationId, state);
  }
}

function mapStarRatingToNumber(starRating) {
  const mapping = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5
  };
  return mapping[starRating] || null;
}

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function getName(review) {
  const raw = review?.reviewer?.displayName || "";
  if (!raw || /google user/i.test(raw)) return "there";
  return raw.split(" ")[0];
}

/** Build reply using Claude if ANTHROPIC_API_KEY is set, otherwise template. */
export async function getReplyText(review, options = {}) {
  const { contact: contactOverride, businessName } = options;
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    try {
      const { generateReplyWithClaude } = await import("./ai.js");
      return await generateReplyWithClaude(review, {
        contact: contactOverride ?? process.env.AUTO_REPLY_CONTACT ?? "",
        businessName: businessName || "our business"
      });
    } catch (err) {
      if (options.logger) options.logger.warn?.(err, "Claude reply failed, using template");
    }
  }
  return buildReplyText(review, contactOverride);
}

export function buildReplyText(review, contactOverride) {
  const rating = mapStarRatingToNumber(review?.starRating);
  const name = getName(review);
  const contact =
    contactOverride ??
    process.env.AUTO_REPLY_CONTACT ??
    "us at our salon phone number (425) 643-9327";

  const personalize = (template) =>
    template
      .replaceAll("{{name}}", name)
      .replaceAll("{{contact}}", contact);

  const templates = {
    5: [
      "Hi {{name}}, thank you so much for the 5‑star review! We’re thrilled you enjoyed your visit.",
      "{{name}}, your 5‑star feedback made our day—thanks for choosing us!",
      "Thanks, {{name}}! We’re so grateful for your 5‑star support and kind words.",
      "Hi {{name}}—we appreciate the 5 stars! Can’t wait to welcome you back soon."
    ],
    4: [
      "Hi {{name}}, thank you for the 4‑star review! We’re glad you enjoyed your visit.",
      "Appreciate the 4 stars, {{name}}—your support means a lot!",
      "Thanks, {{name}}! We’ll keep aiming for 5 stars next time—glad you liked your visit."
    ],
    3: [
      "Hi {{name}}, thank you for the feedback. We’d love to learn how we can make your next visit a 5‑star experience.",
      "Thanks for sharing, {{name}}. We appreciate your feedback and will keep improving.",
      "We hear you, {{name}}—thanks for the honest review. We’re working to make things even better."
    ],
    2: [
      "Hi {{name}}, we’re sorry your experience wasn’t ideal. If you’re open to it, please reach out to {{contact}} so we can make it right.",
      "{{name}}, thank you for letting us know. We’d like to learn more and help—please contact {{contact}}.",
      "We’re sorry to hear this, {{name}}. Your feedback helps us improve; we’d value a chance to follow up via {{contact}}."
    ],
    1: [
      "Hi {{name}}, we sincerely apologize for your experience. Please reach out to {{contact}} so we can make this right.",
      "{{name}}, we’re sorry we missed the mark. If you’re willing, contact {{contact}}—we’d like to fix this.",
      "We’re sorry, {{name}}. Your feedback matters, and we’d appreciate the opportunity to address it via {{contact}}."
    ]
  };

  const bucket = templates[rating] || templates[4];
  return personalize(pickRandom(bucket));
}

export async function processPendingReviews(accountId, locationId, options = {}) {
  const { contact: contactOverride, businessName, logger = console } = options;
  const state = await readState(accountId, locationId);
  const alreadyReplied = new Set(state.repliedReviewIds || []);

  const allowedRatingsEnv = (process.env.AUTO_REPLY_RATINGS || "1,2,3,4,5")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
  const allowedRatings = new Set(allowedRatingsEnv);

  const reviews = await listReviews(accountId, locationId);
  const toReply = reviews.filter((r) => {
    const hasReply = Boolean(r.reviewReply && r.reviewReply.comment);
    const rating = mapStarRatingToNumber(r.starRating);
    const id = r.reviewId || r.name || "";
    return !hasReply && !alreadyReplied.has(id) && rating && allowedRatings.has(rating);
  });

  const results = { attempted: 0, succeeded: 0, failed: 0, details: [] };
  for (const review of toReply) {
    const reviewId = review.reviewId || review.name;
    const rating = mapStarRatingToNumber(review.starRating);
    const comment = await getReplyText(review, {
      contact: contactOverride,
      businessName,
      logger
    });
    results.attempted += 1;
    try {
      await replyToReview(accountId, locationId, reviewId, comment);
      alreadyReplied.add(reviewId);
      results.succeeded += 1;
      results.details.push({ reviewId, rating, status: "ok" });
    } catch (err) {
      logger.error?.(err, "Auto-reply failed");
      results.failed += 1;
      results.details.push({ reviewId, rating, status: "error", message: err?.message });
    }
  }

  state.repliedReviewIds = Array.from(alreadyReplied);
  await writeState(accountId, locationId, state);
  return results;
}

export function startScheduler(appLogger = console) {
  if (String(process.env.AUTO_REPLY_ENABLED || "false").toLowerCase() !== "true") {
    appLogger.info?.("Auto-reply scheduler disabled (set AUTO_REPLY_ENABLED=true to enable)");
    return null;
  }

  const intervalMinutes = Number(process.env.AUTO_REPLY_INTERVAL_MINUTES || 30);
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  appLogger.info?.({ intervalMinutes }, "Starting auto-reply scheduler (multi-tenant)");
  const handle = setInterval(async () => {
    const { getEnabledBusinesses, DEFAULT_CONTACT } = await import("./businesses.js");
    let businesses = await getEnabledBusinesses();
    if (!businesses.length && process.env.AUTO_REPLY_ACCOUNT_ID && process.env.AUTO_REPLY_LOCATION_ID) {
      businesses = [
        {
          accountId: process.env.AUTO_REPLY_ACCOUNT_ID,
          locationId: process.env.AUTO_REPLY_LOCATION_ID,
          contact: process.env.AUTO_REPLY_CONTACT || DEFAULT_CONTACT
        }
      ];
    }
    if (!businesses.length) {
      appLogger.warn?.("Auto-reply: no enabled businesses in config (and no env fallback)");
      return;
    }
    for (const biz of businesses) {
      processPendingReviews(biz.accountId, biz.locationId, {
        contact: biz.contact,
        businessName: biz.name || "our business",
        logger: appLogger
      }).catch((err) => {
        appLogger.error?.(err, { accountId: biz.accountId }, "Auto-reply tick failed");
      });
    }
  }, intervalMs);
  return handle;
}


