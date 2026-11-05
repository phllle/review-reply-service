/**
 * Vertical landing pages (kit §6 spec + §11 titles/metas): one template,
 * three content swaps — /for/dentists, /for/restaurants, /for/salons.
 *
 * Each page: message-matched H1, the kit subhead, the identical Connect CTA
 * (with the §13 Fix 1 expectation line under it), a real proof exchange,
 * the "What happens when you connect" 3-step block, vertical FAQs, the
 * pricing strip, and a minimal footer. The Google tag + /analytics.js load
 * in the head (via googleTagHeadHtml), so click-ID capture and
 * connect_click work exactly as on the homepage.
 *
 * NOTE on routes: the kit's §11 table suggests /dental, /restaurants,
 * /salons slugs; the build brief specifies /for/<vertical>, which is what
 * is routed in index.js and listed in the sitemap.
 */

import { googleTagHeadHtml } from "../analytics.js";
import { escapeHtml } from "./shell.js";

const SUBHEAD =
  "Replyr connects to your Google Business Profile and replies to every review automatically, in your voice, posted as the owner. Free 30-day trial — no credit card, and your first 5 replies are free.";

const EXPECTATION_LINE =
  "Replies start posting after you connect. Preview mode holds 1–3 star replies for 15 minutes and emails you a cancel link — nothing low-star goes live without your say-so.";

const GOOGLE_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`;

function connectCta() {
  return `<a href="/auth/google" class="btn-google">${GOOGLE_ICON_SVG} Connect with Google — it's free</a>`;
}

const NORTHSTAR_PROOF = {
  stars: "★★★★★",
  meta: "Maria K. · 2 days ago",
  review: "Waited a bit but they fixed my crown the same week.",
  replyLabel: "Northstar Dental (Owner)",
  reply:
    "Thank you, Maria! We're glad we could take care of your crown quickly and get you smiling again. We appreciate your trust."
};

const CASTLE_PROOF = {
  stars: "★★★★★",
  meta: "Emma Schuerman · 2 weeks ago",
  review:
    "I have come here many times, it is my regular place. I got my nails done by Kim this time. She did a great job giving me a simple french tip! Love them",
  replyLabel: "Castle Nail Bar (Owner)",
  reply:
    "Thank you so much, Emma! We're thrilled Castle Nail Bar is your go-to spot. Kim will be so happy you loved your french tips! We appreciate your loyalty and look forward to seeing you again very soon."
};

export const VERTICALS = {
  dentists: {
    path: "/for/dentists",
    label: "Dentists",
    title: "Google Review Replies for Dentists | Replyr",
    meta: "Replyr answers patient reviews on Google automatically, in your practice's voice. Preview low-star replies before they post. Free 30-day trial.",
    h1: "Every patient review, answered — without front-desk time",
    proof: NORTHSTAR_PROOF,
    proofNote: null,
    faqs: [
      {
        q: "Will replies sound clinical/appropriate for a practice?",
        a: "Yes. You describe your practice in your settings, and replies are written in that voice — warm, professional, and appropriate for patients. You can adjust the voice anytime."
      },
      {
        q: "What happens with a complaint about treatment?",
        a: "Preview mode holds 1–3 star replies for 15 minutes and emails you a one-click cancel link before anything posts. Low-star replies can include your practice's contact, so the patient can reach you directly and the conversation moves offline."
      },
      {
        q: "We have 3 locations — does it cover all of them?",
        a: "Yes. Replyr supports multiple locations under one Google account — connect once and every location's reviews get replies."
      }
    ]
  },
  restaurants: {
    path: "/for/restaurants",
    label: "Restaurants",
    title: "Google Review Replies for Restaurants | Replyr",
    meta: "Every guest review answered automatically, in your voice, posted as the owner. Free 30-day trial, no credit card. Then $19/mo.",
    h1: "Every guest review answered before your next service",
    proof: CASTLE_PROOF,
    // Kit §6 item 4: no restaurant proof exchange exists yet, so the Castle
    // Nail Bar example runs with honest framing until a real one lands.
    proofNote:
      "A real exchange from Castle Nail Bar, a Replyr salon customer — the same engine answers your guests, in your restaurant's voice.",
    faqs: [
      {
        q: "What about a food-safety complaint?",
        a: "It never gets an argument back. Preview mode holds 1–3 star replies for 15 minutes and emails you a one-click cancel link first; low-star replies acknowledge the concern and invite the guest to contact you directly, so the conversation moves offline."
      },
      {
        q: "Does it reply on Yelp too?",
        a: "No — Replyr is Google-only, on purpose. Google is where most guests search and where reviews move your local ranking, so that's where every review gets answered."
      }
    ]
  },
  salons: {
    path: "/for/salons",
    label: "Salons & Spas",
    title: "Google Review Replies for Salons & Spas | Replyr",
    meta: "Replyr answers every Google review for your salon automatically. See real replies written for Castle Nail Bar. Free 30-day trial.",
    h1: "Every client review answered between appointments",
    proof: CASTLE_PROOF,
    proofNote: null,
    faqs: [
      {
        q: "Will it sound like me?",
        a: "Yes. You describe your salon and your voice in settings, and replies are written to match — warm and personal, never robotic. The reply above is a real one."
      },
      {
        q: "What if a review names my stylist?",
        a: "Replyr thanks them by name — just like the Emma review above, where Kim gets thanked for the french tips. Named, specific replies are exactly what makes them sound human."
      }
    ]
  }
};

function proofBlock(vertical) {
  const p = vertical.proof;
  const note = vertical.proofNote ? `<p class="proof-note">${escapeHtml(vertical.proofNote)}</p>` : "";
  return `<section class="proof" aria-label="Example review and reply">
    ${note}
    <div class="proof-card">
      <div class="proof-top"><span class="proof-stars">${p.stars}</span><span class="proof-meta">${escapeHtml(p.meta)}</span></div>
      <p class="proof-review">${escapeHtml(p.review)}</p>
      <div class="proof-reply">
        <div class="proof-reply-label">${escapeHtml(p.replyLabel)}</div>
        <p>${escapeHtml(p.reply)}</p>
      </div>
    </div>
  </section>`;
}

function stepsBlock() {
  const steps = [
    ["Connect your Google Business Profile", "Takes about 2 minutes."],
    ["We draft replies in your voice", "Preview mode holds 1–3 star replies for 15 minutes and emails you a one-click cancel link."],
    ["Replies post as the owner", "You can pause or turn it off anytime."]
  ];
  return `<section class="connect-steps" aria-label="What happens when you connect">
    <h2>What happens when you <em>connect</em></h2>
    <div class="connect-steps-grid">
      ${steps
        .map(
          ([h, p], i) =>
            `<div class="connect-step"><div class="connect-step-num">${i + 1}</div><h3>${escapeHtml(h)}</h3><p>${escapeHtml(p)}</p></div>`
        )
        .join("\n      ")}
    </div>
  </section>`;
}

const PAGE_CSS = `
  :root { --bg: #0f0f11; --surface: #17171a; --surface2: #1e1e22; --border: rgba(255,255,255,0.07); --accent: #4a9eff; --accent2: #7c6af7; --text: #f0ede8; --muted: #8b8a92; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; min-height: 100vh; overflow-x: hidden; line-height: 1.6; }
  .glow-top { position: fixed; top: -300px; left: 50%; transform: translateX(-50%); width: 900px; height: 600px; background: radial-gradient(ellipse, rgba(124,106,247,0.15) 0%, transparent 65%); pointer-events: none; z-index: 0; }
  .wrapper { max-width: 820px; margin: 0 auto; padding: 48px 24px 80px; position: relative; z-index: 1; }
  .nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 56px; }
  .nav-logo { display: flex; align-items: center; gap: 9px; font-size: 16px; font-weight: 700; color: var(--text); text-decoration: none; }
  .nav-logo-icon { width: 30px; height: 30px; background: linear-gradient(135deg, var(--accent2), var(--accent)); border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; }
  .nav-link { font-size: 13px; color: var(--muted); text-decoration: none; font-weight: 500; }
  .nav-link:hover { color: var(--text); }
  .hero { text-align: center; margin-bottom: 56px; }
  .hero-title { font-family: 'Fraunces', serif; font-size: clamp(34px, 5.5vw, 52px); font-weight: 300; line-height: 1.12; letter-spacing: -0.03em; margin-bottom: 18px; }
  .hero-sub { font-size: 16px; color: var(--muted); max-width: 520px; margin: 0 auto 32px; line-height: 1.65; }
  .btn-google { display: inline-flex; align-items: center; gap: 9px; background: var(--accent); color: #0f0f11; border: none; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 15px; font-weight: 700; cursor: pointer; padding: 14px 26px; transition: all 0.2s; letter-spacing: -0.01em; text-decoration: none; }
  .btn-google:hover { background: #6bafff; transform: translateY(-2px); box-shadow: 0 8px 30px rgba(74,158,255,0.25); }
  .hero-expect { max-width: 470px; margin: 18px auto 0; font-size: 13.5px; color: var(--text); line-height: 1.6; background: rgba(74,158,255,0.08); border: 1px solid rgba(74,158,255,0.18); border-radius: 12px; padding: 12px 16px; text-align: left; }
  .proof { margin-bottom: 40px; }
  .proof-note { font-size: 13px; color: var(--muted); text-align: center; max-width: 480px; margin: 0 auto 14px; line-height: 1.6; }
  .proof-card { max-width: 520px; margin: 0 auto; text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px 22px; }
  .proof-top { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .proof-stars { color: #f59e0b; letter-spacing: 2px; font-size: 14px; }
  .proof-meta { font-size: 12px; color: var(--muted); }
  .proof-review { font-size: 14px; color: var(--text); line-height: 1.55; }
  .proof-reply { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  .proof-reply-label { font-size: 12px; font-weight: 600; color: var(--accent2); margin-bottom: 5px; }
  .proof-reply p { font-size: 13px; color: var(--muted); line-height: 1.55; }
  .mid-cta { text-align: center; margin-bottom: 64px; }
  .connect-steps { margin-bottom: 64px; }
  .connect-steps h2 { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 400; text-align: center; margin-bottom: 24px; }
  .connect-steps h2 em { font-style: italic; color: var(--accent); }
  .connect-steps-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 640px) { .connect-steps-grid { grid-template-columns: 1fr; } }
  .connect-step { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px; }
  .connect-step-num { width: 28px; height: 28px; border-radius: 50%; background: rgba(74,158,255,0.14); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; margin-bottom: 10px; }
  .connect-step h3 { font-size: 14px; font-weight: 700; margin-bottom: 5px; }
  .connect-step p { font-size: 13px; color: var(--muted); line-height: 1.6; }
  .faq { max-width: 640px; margin: 0 auto 64px; }
  .faq h2 { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 400; text-align: center; margin-bottom: 24px; }
  .faq details { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 0 18px; margin-bottom: 10px; }
  .faq summary { cursor: pointer; padding: 16px 0; font-weight: 600; font-size: 15px; list-style: none; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq details p { color: var(--muted); font-size: 14px; line-height: 1.65; padding: 0 0 16px; }
  .pricing-strip { text-align: center; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 32px 28px; margin-bottom: 64px; }
  .pricing-strip .price-line { font-family: 'Fraunces', serif; font-size: 24px; font-weight: 400; margin-bottom: 8px; }
  .pricing-strip .pro-line { font-size: 13.5px; color: var(--muted); margin-bottom: 22px; }
  footer { text-align: center; }
  .footer-brand { display: flex; align-items: center; justify-content: center; gap: 9px; margin-bottom: 12px; }
  .footer-links { font-size: 12.5px; color: var(--muted); }
  .footer-links a { color: var(--muted); text-decoration: none; }
  .footer-links a:hover { color: var(--text); }
`;

/** Render one vertical landing page. Returns "" for an unknown key. */
export function verticalPageHtml(key) {
  const v = VERTICALS[key];
  if (!v) return "";
  const canonical = `https://replyr.pro${v.path}`;
  const others = Object.entries(VERTICALS)
    .filter(([k]) => k !== key)
    .map(([, o]) => `<a href="${o.path}">${escapeHtml(o.label)}</a>`)
    .join(" · ");
  const faqHtml = v.faqs
    .map((f) => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`)
    .join("\n    ");
  // RESTAURANT PROOF PLACEHOLDER (kit §6 item 4): when a real restaurant
  // review/reply exchange is available, swap CASTLE_PROOF for it on the
  // restaurants entry above and delete the proofNote framing line.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(v.title)}</title>
<meta name="description" content="${escapeHtml(v.meta)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(v.title)}">
<meta property="og:description" content="${escapeHtml(v.meta)}">
<meta property="og:url" content="${canonical}">
${googleTagHeadHtml()}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<noscript><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"></noscript>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="glow-top"></div>
<div class="wrapper">
  <nav class="nav">
    <a href="/" class="nav-logo"><span class="nav-logo-icon">💬</span>Replyr</a>
    <a href="/#faq" class="nav-link">FAQ</a>
  </nav>
  <main>
  <section class="hero">
    <h1 class="hero-title">${escapeHtml(v.h1)}</h1>
    <p class="hero-sub">${escapeHtml(SUBHEAD)}</p>
    ${connectCta()}
    <p class="hero-expect">${escapeHtml(EXPECTATION_LINE)}</p>
  </section>
  ${proofBlock(v)}
  <div class="mid-cta">${connectCta()}</div>
  ${stepsBlock()}
  <section class="faq" aria-label="Frequently asked questions">
    <h2>Questions, answered</h2>
    ${faqHtml}
  </section>
  <section class="pricing-strip">
    <p class="price-line">Free for 30 days, then $19/mo. Cancel anytime.</p>
    <p class="pro-line">Need review requests and birthday texts too? Replyr Pro from $39/mo.</p>
    ${connectCta()}
  </section>
  </main>
  <footer>
    <div class="footer-brand"><span class="nav-logo-icon">💬</span><strong>Replyr</strong></div>
    <div class="footer-links">
      <a href="/subscribe">Pricing</a> · <a href="/#faq">FAQ</a> · Also for: ${others}
    </div>
  </footer>
</div>
</body>
</html>`;
}
