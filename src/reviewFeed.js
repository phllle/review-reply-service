import * as db from "./db.js";
import { listReviews } from "./google.js";
import { getBusiness } from "./businesses.js";
import { canAccessAccount, readSessionAccountId } from "./sessionAuth.js";

const STAR = {
  STAR_RATING_ONE: 1,
  STAR_RATING_TWO: 2,
  STAR_RATING_THREE: 3,
  STAR_RATING_FOUR: 4,
  STAR_RATING_FIVE: 5
};

export function registerReviewFeed(app) {
  app.get("/reviews", async (req, res, next) => {
    try {
      const accountId =
        (req.query.accountId && String(req.query.accountId).trim()) ||
        readSessionAccountId(req);
      if (!accountId) return res.status(401).json({ error: "Sign in required" });
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const business = await getBusiness(accountId);
      if (!business?.locationId) return res.json({ reviews: [] });

      const raw = await listReviews(accountId, business.locationId);
      const pendingByReview = {};
      if (db.useDb()) {
        try {
          const pending = await db.listOpenPendingRepliesForAccount(
            accountId,
            business.locationId
          );
          for (const row of pending || []) {
            if (row?.reviewId) pendingByReview[row.reviewId] = row;
          }
        } catch (err) {
          req.log?.warn?.(err, "Could not load pending replies for dashboard");
        }
      }

      const reviews = (raw || []).slice(0, 12).map((r) => {
        const reviewId = r.reviewId || (r.name ? String(r.name).split("/").pop() : "");
        const pending = reviewId ? pendingByReview[reviewId] : null;
        const replyComment = r.reviewReply?.comment ? String(r.reviewReply.comment) : "";
        let status = "unreplied";
        if (replyComment) status = "posted";
        else if (pending) status = "holding";
        return {
          reviewId,
          reviewerName: r.reviewer?.displayName || "Customer",
          rating: STAR[r.starRating] || 0,
          comment: r.comment ? String(r.comment) : "",
          createTime: r.createTime || r.updateTime || null,
          replyComment,
          status,
          holdUntil: pending?.sendAfter || null
        };
      });
      res.json({ reviews });
    } catch (err) {
      next(err);
    }
  });
}
