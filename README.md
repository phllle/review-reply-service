## Review Reply Service (Google Business Profile)

Minimal Node/Express service that authenticates with Google and replies to Google Business Profile reviews via API.

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
- **STRIPE_WEBHOOK_SECRET** – From Stripe Dashboard → Developers → Webhooks → Add endpoint: `https://your-app.up.railway.app/webhooks/stripe`, events `checkout.session.completed` and `customer.subscription.deleted`.
- **STRIPE_CUSTOMER_PORTAL_URL** – Billing portal link (Settings → Billing → Customer portal). **BASE_URL** – Optional; e.g. `https://your-app.up.railway.app` for success/cancel URLs in Checkout.
