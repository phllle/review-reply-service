/**
 * Simple public marketing/legal pages (/contact, /compliance, /privacy, /terms).
 * Extracted verbatim from index.js — no behavior change. Each returns a full HTML
 * document via the shared dark shell.
 */

import { escapeHtml, darkShellHtml } from "./shell.js";
import { publicContactEmail, publicContactMailtoHref } from "../publicContact.js";

export function renderContactPage() {
  const contactEmail = publicContactEmail();
  const emailHtml = `<p><a href="${publicContactMailtoHref()}" class="contact-link">${escapeHtml(contactEmail)} →</a></p>`;
  return darkShellHtml({
    title: "Replyr – Contact us",
    canonicalPath: "/contact",
    bodyHtml: `    <h1>Contact <em>us</em></h1>
    <p>Questions about connecting Google, billing, or Replyr Pro? Whether you're already set up or just exploring, email us and we'll help.</p>
    ${emailHtml}
    <p style="font-size:13px">We typically reply within one business day.</p>
    <p style="margin-top:14px">Ready to start? <a href="/subscribe">View plans and pricing →</a></p>
    <p class="doc-back" style="margin-top:24px;text-align:left"><a href="/">← Back to Replyr</a></p>`,
    narrow: true,
    description: "Get in touch with Replyr — questions, support, or feedback."
  });
}

// Compliance / acceptable use (linked from Pro UI and email footer). Wording aligned with toll-free use case: marketing/promotional messages.
export function renderCompliancePage() {
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
  return darkShellHtml({
    title: "Replyr – Messaging compliance",
    canonicalPath: "/compliance",
    bodyHtml: body,
    description: "Replyr Pro messaging compliance — opt-in workflow, business confirmation, opt-out handling."
  });
}

// Privacy policy (linked from Google OAuth consent screen)
export function renderPrivacyPage() {
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
  return darkShellHtml({
    title: "Replyr – Privacy policy",
    canonicalPath: "/privacy",
    bodyHtml: body,
    description: "Replyr privacy policy — what we collect, how we use it, and your choices."
  });
}

// Terms of service (linked from Google OAuth consent screen)
export function renderTermsPage() {
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
  return darkShellHtml({
    title: "Replyr – Terms of service",
    canonicalPath: "/terms",
    bodyHtml: body,
    description: "Replyr terms of service."
  });
}
