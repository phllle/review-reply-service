/**
 * AI-generated review replies using Anthropic Claude.
 * Set ANTHROPIC_API_KEY to enable; falls back to template replies if unset or on error.
 */

const MAX_REPLY_CHARS = 500; // Google allows more; keep replies readable, truncate at word boundary

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

  // Truncate at word boundary so we don't cut mid-word (e.g. "ba...")
  if (text.length <= MAX_REPLY_CHARS) return text;
  const cut = text.slice(0, MAX_REPLY_CHARS - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const end = lastSpace > MAX_REPLY_CHARS * 0.7 ? lastSpace : cut.length;
  return text.slice(0, end).trim() + (end < text.length ? "…" : "");
}

function mapStarRatingToNumber(starRating) {
  const mapping = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return mapping[starRating] || null;
}

/**
 * Generate a short campaign message (birthday or event) for Replyr Pro.
 * @param {object} opts - { type: 'birthday'|'event', businessName?, eventName? }
 * @returns {Promise<string>} - Plain text message; use {{first_name}} and {{offer}} in template.
 */
export async function generateCampaignMessageWithClaude(opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const { type = "birthday", businessName = "our business", eventName } = opts;
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514";

  const systemPrompt = `You write short, friendly marketing messages for a small business. Rules:
- Output plain text only. No markdown, bullets, or hashtags.
- Include placeholders: {{first_name}} for the customer's name, {{offer}} for the discount/offer (e.g. "20% off").
- Keep it under 150 words. Warm and professional.`;

  const userPrompt =
    type === "birthday"
      ? `Business: ${businessName}. Write a birthday email message. Use {{first_name}} and {{offer}}. Example tone: "Happy birthday, {{first_name}}! As a thank you, {{offer}}. We hope to see you soon."`
      : `Business: ${businessName}. Write a short promotional email for the event: ${eventName || "holiday"}. Use {{first_name}} and {{offer}}. Keep it brief and inviting.`;

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
  return text || "Happy birthday, {{first_name}}! As a thank you, {{offer}}. We hope to see you soon.";
}
