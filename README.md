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

### Local dev shortcut (skip Google OAuth)
For UI work where you don't want to set up Google OAuth credentials, set `REPLYR_DEV_LOGIN=1` in `.env` and visit:

- `http://localhost:3000/dev/login` — mints a session cookie for `accountId=dev-local` and redirects to `/connected`.
- `http://localhost:3000/dev/login?pro=1` — same, but flips `isPro=true` so you can exercise Pro UI.
- `http://localhost:3000/dev/login?return_to=/subscribe` — land on any path with a session.

The route 404s unless **both** `NODE_ENV !== production` **and** `REPLYR_DEV_LOGIN=1`, so it cannot ship live by accident. Pro page itself still requires `DATABASE_URL` for full functionality (otherwise it shows the no-DB fallback).

### Tests
Run unit tests with `npm test` (uses Node's built-in `node:test` runner; no extra deps). Watch mode: `npm run test:watch`.

### Error tracking (Sentry)
Set `SENTRY_DSN` to enable error reporting from Express request handlers, the auto-reply scheduler, the campaign scheduler, the Stripe webhook, and the Twilio SMS webhook. Leave it unset to disable — the app runs identically without it.

### Auto-reply preview mode
Each business has an `auto_reply_mode`: `'instant'` (default — current behavior) or `'delayed'`. In delayed mode, AI replies for low-star reviews (1–3 stars by default) are queued for 15 minutes and the business owner gets an email with a one-click cancel link before the reply posts to Google. 4–5 star replies still post instantly. Requires `RESEND_API_KEY`, `REPLYR_SESSION_SECRET` (signs the cancel token), and a saved owner email per business.

The owner's email is auto-filled at OAuth time when the user grants the `openid email` scopes (asked alongside `business.manage`). Existing users who connected before this scope was requested can still set the email manually on `/connected`.

### Admin metrics
`/admin/metrics` (HTML) and `/admin/metrics.json` (same data as JSON) — gated by `ADMIN_SECRET` (sign in at `/admin`, or send the `X-Admin-Secret` header). Shows MRR, plans by tier, 30-day funnel (trials started, trial→paid conversion, active trials, trial-end attrition), and current activity (connected businesses, auto-reply enabled, queued replies, Pro SMS this month). MRR is computed locally from the `businesses` table using `STRIPE_*_AMOUNT_CENTS` env vars; if the Stripe webhook drifts, MRR will surface that drift.

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
To use Claude for generating review replies instead of templates, set **ANTHROPIC_API_KEY** (from [Anthropic Console](https://console.anthropic.com)). Optional: **ANTHROPIC_MODEL** (default `claude-sonnet-4-20250514`). Replies are based on star rating; for 1–3 star reviews Claude is prompted to include the business’s contact info (from the connected page). Replies are Claude-only; if the key is unset or the API fails for a review, that review is skipped (no reply posted).

### Failure alerts (email & SMS)
When the scheduled auto-reply run throws or any reply fails, you can get notified:

- **Email:** Set **ALERT_EMAIL** (e.g. `you@example.com`) and **RESEND_API_KEY** (from [Resend](https://resend.com)). Optional: **ALERT_FROM_EMAIL** (default `Replyr <onboarding@resend.dev>`; use a verified domain in production).
- **SMS:** Set **ALERT_PHONE** (e.g. `+15551234567`), **TWILIO_ACCOUNT_SID**, **TWILIO_AUTH_TOKEN**, and **TWILIO_FROM_NUMBER** (from [Twilio](https://twilio.com)).

You can set only one or both. Alerts are sent when the scheduler tick throws (e.g. API error) or when any reply in a run fails (e.g. Claude or Google API failure).

### Security & sessions
- **REPLYR_SESSION_SECRET** – Required in production. After Google OAuth, Replyr sets an HttpOnly session cookie so API routes (`/businesses`, `/free-reply`, Pro endpoints, etc.) only work for the signed-in Google account.
- **ADMIN_SECRET** – Protects `/admin`, `/admin.js`, `/admin/metrics(.json)`, `/admin/backfill-place-ids`, and the admin JSON export on `GET /businesses`. **Auth is header or cookie only — never a query string.** Open **`/admin`**, enter the secret in the sign-in form (POSTed once), and Replyr sets a short-lived HttpOnly `replyr_admin` cookie (~12h) bound to a hash of the current `ADMIN_SECRET` — rotating the secret immediately invalidates outstanding admin cookies. Scripts/automation can send the `X-Admin-Secret` header instead. Secrets are compared with `crypto.timingSafeEqual`.
- **Test senders** (`/test-alert`, `/test-sms`, `/test-sms-diag`, `/test-trigger-event`, `/test-trigger-birthday`) **return 404 in production** (`NODE_ENV=production`). Outside production they require the `X-Test-Secret` header (= `TEST_ALERT_SECRET`) or `X-Admin-Secret` — never `?secret=`.
- **BASE_URL** – Set to your public origin (e.g. `https://replyr.pro`) so Twilio can verify webhook signatures for `POST /webhooks/twilio/sms`.

### Secret rotation (ops)
`ADMIN_SECRET` and `TEST_ALERT_SECRET` are passed as `?secret=` query params on some routes, so they can leak via server logs, Sentry, screenshots, tickets, or browser history. Treat any exposure as compromise and rotate. Routes fail closed: if a secret is **unset** the route returns `503`; after rotation, old `?secret=` URLs return `401`.

Rotation runbook:
1. **Make the repo private** (once): GitHub → repo → Settings → General → Danger Zone → Change repository visibility → Private.
2. **Generate new values** (locally; do not paste real secrets into commits, tickets, or chat):
   ```
   openssl rand -hex 32   # ADMIN_SECRET
   openssl rand -hex 32   # TEST_ALERT_SECRET
   ```
   Also rotate `REPLYR_SESSION_SECRET` and `UNSUBSCRIBE_SECRET` the same way **if** they ever appeared in logs/screenshots. (Rotating `REPLYR_SESSION_SECRET` invalidates existing signed session cookies and reply-cancel/unsubscribe tokens — users just sign in again.)
3. **Update Railway** → the web service → Variables → replace the values → **restart** the service.
4. **Verify old secrets are dead:** an old `/admin?secret=OLD` and `/test-alert?secret=OLD` must return `401`. A route with its secret unset returns `503`.
5. **Scrub the old values** from: Railway deploy/HTTP logs, Sentry events, saved screenshots, support tickets, and your browser history/bookmarks.

Never commit `.env` (it is git-ignored). Prefer the `X-Admin-Secret` header over `?secret=` for admin requests so the secret stays out of URLs/logs.

### Twilio: A2P 10DLC & spending (operator checklist)
These are **Twilio Console** steps (not env vars):
1. **A2P 10DLC** – For US long-code SMS to customers, complete **Standard** brand registration and a suitable **campaign** (platform sending on behalf of multiple businesses). Sole Proprietor registration is not appropriate for multi-tenant campaign SMS.
2. **Spending limit** – In Twilio → Billing → **Spending limits**, set a monthly or all-time cap so unexpected volume cannot drain the account.
3. **Campaign SMS flag** – Set **`CAMPAIGN_SMS_ENABLED=true`** only when you intend to send Pro campaign SMS; metering and caps apply per business tier in the database.

Replyr uses **pay-as-you-go** Twilio pricing (per message); there is no separate “plan” to subscribe to beyond registration and carrier fees.
