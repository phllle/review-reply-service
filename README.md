## Review Reply Service (Replyr)

Minimal Node/Express service that authenticates with Google and replies to Google Business Profile reviews via API.

### Services Replyr uses

| Service | What it's for | Where to configure | Env vars (main) |
|--------|----------------|--------------------|-----------------|
| **Google Cloud** | Sign-in (OAuth) and Google Business Profile API (reviews, locations, post replies) | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials, OAuth consent screen | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| **PostgreSQL** | Persist tokens, businesses, auto-reply state, subscriptions, Pro contacts & campaigns | Railway Postgres plugin or any Postgres host | `DATABASE_URL` |
| **Stripe** | Subscriptions (Replyr + Replyr Pro), Checkout, Customer Portal, webhooks | [Stripe Dashboard](https://dashboard.stripe.com) → Products, Webhooks, Billing → Customer portal | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_CUSTOMER_PORTAL_URL`, `BASE_URL` |
| **Anthropic (Claude)** | AI-generated review replies and Pro campaign copy (birthday, events, one-off) | [Anthropic Console](https://console.anthropic.com) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (optional) |
| **Resend** | Transactional email: failure alerts, Pro campaign emails, unsubscribe links | [Resend](https://resend.com) → API Keys, Domains (verify replyr.pro for sending) | `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `ALERT_EMAIL`, `UNSUBSCRIBE_SECRET`, `CAMPAIGN_FOOTER_ADDRESS` |
| **Twilio** | SMS: failure alerts, Pro campaign SMS (birthday, events, one-off), STOP opt-out webhook | [Twilio Console](https://console.twilio.com) → Phone Numbers, Messaging webhook | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_PHONE`, `CAMPAIGN_SMS_ENABLED` |
| **Railway** | Hosting, custom domain (e.g. replyr.pro), env vars | [Railway](https://railway.app) → Project → Settings (Networking), Variables | `BASE_URL`, `PORT` |
| **Domain (e.g. Squarespace)** | replyr.pro DNS: A/ALIAS/CNAME to Railway, TXT for Railway verify; Resend DKIM/SPF for email | Squarespace (or registrar) → Domains → DNS | — |

**Quick links**

- **Google OAuth:** Authorized redirect URI = `https://replyr.pro/auth/google/callback` (and origin `https://replyr.pro`).
- **Stripe webhook:** Endpoint URL = `https://replyr.pro/webhooks/stripe`; events: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.updated`.
- **Twilio SMS webhook:** "A message comes in" = `https://replyr.pro/webhooks/twilio/sms` (for STOP handling).

---

### Setup
1. cd ~/review-reply-service && npm install
2. Copy .env.example to .env and fill GOOGLE_* values.
3. Start: npm run dev
4. Connect Google at http://localhost:3000/auth/google

### Reply example
POST /google/reviews/{ACCOUNT_ID}/{LOCATION_ID}/{REVIEW_ID}/reply with { "comment": "Thank you!" }.

### Database (production)
On Railway (or any host with ephemeral filesystem), set **DATABASE_URL** to a PostgreSQL connection string so tokens, businesses, and auto-reply state persist across redeploys. Without it, the app uses JSON files (`tokens.json`, `businesses.json`, `auto-state.json`).

- **Railway:** Add the Postgres plugin to your project; it sets `DATABASE_URL` automatically. Tables (`tokens`, `businesses`, `auto_state`) are created on first startup.
- **Local:** Omit `DATABASE_URL` to keep using the file-based store.

### Stripe (subscriptions & webhook)
- **SUBSCRIBE_URL** – Stripe Payment Link (fallback when user has no accountId). **SUBSCRIBE_PRICE** – Label shown on subscribe page (e.g. `$10 / month`).
- **STRIPE_SECRET_KEY** – Required for Checkout and webhook. **STRIPE_PRICE_ID** – Price ID (e.g. `price_xxx`) for `POST /create-checkout-session` so we can pass `accountId` and record subscription in the webhook.
- **STRIPE_WEBHOOK_SECRET** – From Stripe Dashboard → Developers → Webhooks → Add endpoint: `https://your-app.up.railway.app/webhooks/stripe`, events: `checkout.session.completed`, `customer.subscription.deleted`, and **`customer.subscription.updated`** (needed for Replyr Pro plan flag).
- **STRIPE_CUSTOMER_PORTAL_URL** – Billing portal link (Settings → Billing → Customer portal). **BASE_URL** – Optional; e.g. `https://your-app.up.railway.app` for success/cancel URLs in Checkout.

### Replyr Pro (customer list & campaigns)
- The **customer list** (CSV upload) on the connected page is only available to businesses with **Replyr Pro**.
- **Option A – Payment Link:** Set **SUBSCRIBE_PRO_URL** to your Stripe Payment Link (e.g. `https://buy.stripe.com/...`). The "Subscribe to Pro" button will open that link. Also set **SUBSCRIBE_PRO_PRICE** (e.g. `$29 / month`) for the label. With a Payment Link, `is_pro` is not set automatically; you can set it in Admin or the DB after they subscribe.
- **Option B – Checkout Session:** Set **STRIPE_PRO_PRICE_ID** (the Price ID for your Pro product) and **SUBSCRIBE_PRO_PRICE**. The button will create a Checkout session and the webhook will set `is_pro` when they complete payment. You can use both: if **STRIPE_PRO_PRICE_ID** is set, Pro uses Checkout (and `is_pro` is set); otherwise **SUBSCRIBE_PRO_URL** is used.

### AI replies (Anthropic Claude)
To use Claude for generating review replies instead of templates, set **ANTHROPIC_API_KEY** (from [Anthropic Console](https://console.anthropic.com)). Optional: **ANTHROPIC_MODEL** (default `claude-sonnet-4-20250514`). Replies are based on star rating; for 1–2 star reviews Claude is prompted to include the business’s contact info (from the connected page). Replies are Claude-only; if the key is unset or the API fails for a review, that review is skipped (no reply posted).

### Failure alerts (email & SMS)
When the scheduled auto-reply run throws or any reply fails, you can get notified:

- **Email:** Set **ALERT_EMAIL** (e.g. `you@example.com`) and **RESEND_API_KEY** (from [Resend](https://resend.com)). Optional: **ALERT_FROM_EMAIL** (default `Replyr <onboarding@resend.dev>`; use a verified domain in production).
- **SMS:** Set **ALERT_PHONE** (e.g. `+15551234567`), **TWILIO_ACCOUNT_SID**, **TWILIO_AUTH_TOKEN**, and **TWILIO_FROM_NUMBER** (from [Twilio](https://twilio.com)).

You can set only one or both. Alerts are sent when the scheduler tick throws (e.g. API error) or when any reply in a run fails (e.g. Claude or Google API failure).
