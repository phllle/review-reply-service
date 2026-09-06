/**
 * Trial free-reply policy (pure, testable).
 *
 * Trial accounts may post up to FREE_REPLY_CAP free replies to their latest
 * unreplied Google reviews. The HTTP route (/free-reply) does the IO; this
 * module owns the decisions: eligibility, unreplied selection, and how many
 * to post.
 */

export const FREE_REPLY_CAP = 5;

/**
 * Is this business allowed to use free replies right now?
 * Trial-only: active trial AND not subscribed AND under the cap.
 * @returns {{ok: true, used: number, remaining: number} | {ok: false, error: string}}
 */
export function freeReplyEligibility(business, now = Date.now()) {
  const trialActive =
    business && business.trialEndsAt != null && new Date(business.trialEndsAt).getTime() > now;
  if (!trialActive || (business && business.subscribedAt)) {
    return { ok: false, error: "Free replies are only available during your free trial." };
  }
  const used = Number((business && business.freeRepliesUsed) || 0);
  if (used >= FREE_REPLY_CAP) {
    return { ok: false, error: "You've used your 5 free replies." };
  }
  return { ok: true, used, remaining: FREE_REPLY_CAP - used };
}

/** Extract a review id from a Google review object. */
export function reviewIdOf(review) {
  if (!review) return "";
  return review.reviewId || (review.name ? String(review.name).split("/").pop() : "");
}

/**
 * Unreplied reviews (no owner reply, not in the already-replied set), newest first.
 */
export function selectUnrepliedNewestFirst(reviews, repliedIds) {
  const set = new Set(repliedIds || []);
  return (reviews || [])
    .filter((r) => (!r.reviewReply || !r.reviewReply.comment) && !set.has(reviewIdOf(r)))
    .sort(
      (a, b) =>
        new Date(b.createTime || b.updateTime || 0).getTime() -
        new Date(a.createTime || a.updateTime || 0).getTime()
    );
}

/** How many reviews to post this run given remaining budget and available unreplied. */
export function freeRepliesToPost(remaining, unrepliedCount) {
  return Math.max(0, Math.min(remaining, unrepliedCount));
}
