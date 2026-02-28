/**
 * AI-generated review replies using Anthropic Claude.
 * Set ANTHROPIC_API_KEY to enable; falls back to template replies if unset or on error.
 */

const MAX_REPLY_CHARS = 350; // Google review replies work best when concise

/**
 * Generate a single review reply using Claude.
 * @param {object} review - Google review object: { starRating, comment?, reviewer?: { displayName } }
 * @param {object} options - { contact: string, businessName?: string }
 * @returns {Promise<string>} - Plain text reply (no markdown)
 */
export async function generateReplyWithClaude(review, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const { contact = "", businessName = "the business" } = options;
  const ratingNum = mapStarRatingToNumber(review?.starRating);
  const reviewText = (review?.comment || "").trim() || "(No comment)";
  const reviewerName = (review?.reviewer?.displayName || "").trim();
  const name = reviewerName && !/google user/i.test(reviewerName) ? reviewerName.split(" ")[0] : "there";

  const isLowRating = ratingNum === 1 || ratingNum === 2;
  const systemPrompt = `You write short, professional replies to Google Business reviews. Rules:
- Reply as the business owner. Keep it under ${MAX_REPLY_CHARS} characters.
- Be warm and grateful for positive reviews; empathetic and solution-focused for negative ones.
- Do not use markdown, bullet points, or hashtags. Output plain text only.
- For 1- or 2-star reviews, you must invite the customer to reach out using the contact information provided. Include that contact in your reply.`;

  const userPrompt = `Business name: ${businessName}
Star rating: ${ratingNum} out of 5
Reviewer's first name: ${name}
Review text: "${reviewText}"
${isLowRating ? `Contact for the customer to reach out: ${contact}` : ""}

Write a single, short reply to this review. Output only the reply text, nothing else.`;

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514";

  const message = await client.messages.create({
    model,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });

  const text = message.content
    ?.filter((block) => block.type === "text")
    ?.map((block) => block.text)
    ?.join("")
    ?.trim();

  if (!text) {
    throw new Error("Claude returned no text");
  }

  // Truncate if over limit (safety)
  return text.length > MAX_REPLY_CHARS ? text.slice(0, MAX_REPLY_CHARS - 3) + "..." : text;
}

function mapStarRatingToNumber(starRating) {
  const mapping = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return mapping[starRating] || null;
}
