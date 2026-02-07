import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { listReviews, replyToReview } from "./google.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, "..", "auto-state.json");

async function readState() {
  try {
    const data = await fs.readFile(STATE_PATH, "utf8");
    return JSON.parse(data);
  } catch {
    return { repliedReviewIds: [] };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
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

function buildReplyText(review) {
  const rating = mapStarRatingToNumber(review?.starRating);
  const name = getName(review);
  const contact = process.env.AUTO_REPLY_CONTACT || "us at our salon phone number (425) 643-9327";

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

export async function processPendingReviews(accountId, locationId, logger = console) {
  const state = await readState();
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
    const comment = buildReplyText(review);
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
  await writeState(state);
  return results;
}

export function startScheduler(appLogger = console) {
  if (String(process.env.AUTO_REPLY_ENABLED || "false").toLowerCase() !== "true") {
    appLogger.info?.("Auto-reply scheduler disabled (set AUTO_REPLY_ENABLED=true to enable)");
    return null;
  }
  const accountId = process.env.AUTO_REPLY_ACCOUNT_ID;
  const locationId = process.env.AUTO_REPLY_LOCATION_ID;
  const intervalMinutes = Number(process.env.AUTO_REPLY_INTERVAL_MINUTES || 30);
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  if (!accountId || !locationId) {
    appLogger.warn?.("Auto-reply not started: missing AUTO_REPLY_ACCOUNT_ID or AUTO_REPLY_LOCATION_ID");
    return null;
  }

  appLogger.info?.({ intervalMinutes }, "Starting auto-reply scheduler");
  const handle = setInterval(() => {
    processPendingReviews(accountId, locationId, appLogger).catch((err) => {
      appLogger.error?.(err, "Auto-reply tick failed");
    });
  }, intervalMs);
  return handle;
}


