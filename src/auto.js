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

/** Build reply using Claude only. Requires ANTHROPIC_API_KEY. */
export async function getReplyText(review, options = {}) {
  const { contact: contactOverride, businessName } = options;
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is not set; cannot generate reply");
  }
  const { generateReplyWithClaude } = await import("./ai.js");
  return await generateReplyWithClaude(review, {
    contact: contactOverride ?? process.env.AUTO_REPLY_CONTACT ?? "",
    businessName: businessName || "our business"
  });
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
    results.attempted += 1;
    try {
      const comment = await getReplyText(review, {
        contact: contactOverride,
        businessName,
        logger
      });
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
      })
        .then(async (result) => {
          if (result.failed > 0) {
            const { sendFailureAlert } = await import("./alert.js");
            await sendFailureAlert({
              businessName: biz.name,
              accountId: biz.accountId,
              result
            });
          }
        })
        .catch(async (err) => {
          appLogger.error?.(err, { accountId: biz.accountId }, "Auto-reply tick failed");
          const { sendFailureAlert } = await import("./alert.js");
          await sendFailureAlert({
            businessName: biz.name,
            accountId: biz.accountId,
            error: err
          });
        });
    }
  }, intervalMs);
  return handle;
}
