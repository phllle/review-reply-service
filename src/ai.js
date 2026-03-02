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
  const { type = "birthday", businessName = "our business", eventName, offerText, businessPrompt } = opts;
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514";

  const systemPrompt = `You write short, friendly marketing messages for a small business. Rules:
- Output plain text only. No markdown, bullets, or hashtags.
- Include {{first_name}} for the customer's name. Include the exact offer/discount in the message (use {{offer}} as placeholder if the offer will be inserted later).
- Tailor the message to the specific business: use its name and infer the business type from the name (e.g. nail salon, restaurant, Pho, spa, retail) so the copy fits naturally — mention relevant services, products, or vibes (e.g. nails/manicure for a nail salon, food/dining for a restaurant).
- Keep it under 150 words. Warm and professional.`;

  const offerHint = offerText ? ` The offer to include (use {{offer}} or weave in naturally): "${offerText}".` : "";
  const businessHint = businessPrompt ? ` The business owner provided this description — use it to tailor the message: "${businessPrompt}".` : "";
  const userPrompt =
    type === "birthday"
      ? `Business: "${businessName}".${businessHint} Write a birthday email message tailored to this business (use its name and type so it feels specific — e.g. for a nail salon mention nails/manicure; for a restaurant mention dining/food, cuisine type, or vibe). Use {{first_name}}.${offerHint} Example: "Happy birthday, {{first_name}}! As a thank you, {{offer}}. We hope to see you soon."`
      : `Business: "${businessName}".${businessHint} Write a short promotional email for the event: ${eventName || "holiday"}, tailored to this business (use its name and type). Use {{first_name}} and the offer.${offerHint} Keep it brief and inviting.`;

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

/**
 * Generate subject and body for a one-off promo from the business's description.
 * @param {object} opts - { prompt: string, businessName?: string }
 * @returns {Promise<{ subject: string, body: string }>}
 */
export async function generateOneOffWithClaude(opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const { prompt = "", businessName = "our business" } = opts;
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514";

  const systemPrompt = `You write short marketing emails for a small business. Rules:
- Output plain text only. No markdown, bullets, or hashtags.
- Use {{first_name}} in the body for the customer's name (filled automatically from their list).
- Keep subject under 60 characters. Body under 150 words. Warm and professional.`;

  const userPrompt = `Business: ${businessName}. They want to send this one-off announcement: "${prompt}"

Reply with exactly two lines:
LINE 1: The email subject (one short line).
LINE 2: The email body (can be multiple sentences; use {{first_name}} where appropriate).

Format your reply as:
SUBJECT: your subject here
BODY: your body text here`;

  const message = await client.messages.create({
    model,
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });

  const text = message.content
    ?.filter((block) => block.type === "text")
    ?.map((block) => block.text)
    ?.join("")
    ?.trim();
  if (!text) return { subject: "Special offer from us", body: `Hi {{first_name}},\n\nWe have a promotion we think you'll love. Reach out to learn more!` };

  const subjectMatch = text.match(/SUBJECT:\s*(.+?)(?:\n|$)/i);
  const bodyMatch = text.match(/BODY:\s*([\s\S]+?)(?:\n*$)/i);
  let subject = subjectMatch ? subjectMatch[1].trim() : null;
  let body = bodyMatch ? bodyMatch[1].trim() : null;
  if (!subject || !body) {
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    subject = subject || (lines[0]?.slice(0, 80) || "Special offer");
    body = body || (lines.slice(1).join("\n\n") || lines[0] || text);
  }
  return { subject, body };
}
