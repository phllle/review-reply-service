# Replyr – Roadmap & to-do

Ongoing ideas and next steps. Check off as you go.

---

## Stripe & payments

- [x] **Set up Stripe** – Product/price + Payment Link; set `SUBSCRIBE_URL` and `SUBSCRIBE_PRICE` in env.
- [x] **Stripe Customer Portal** – Add `STRIPE_CUSTOMER_PORTAL_URL` (Settings → Billing → Customer portal link). “Manage billing” appears on connected and subscribe pages.
- [x] **Stripe webhook** – `POST /webhooks/stripe` to receive `checkout.session.completed` (or `customer.subscription.*`), store subscription status per business (e.g. `subscribed: true` in DB) so you know who’s paid.
- [x] **Success/cancel URLs** – Set in Checkout (success → /connected?subscribed=1, cancel → /subscribe) and set “After payment” / “After cancellation” URLs (e.g. success → `/connected?subscribed=1`, cancel → `/subscribe`) so users return to your app.

---

## Trial & subscription behavior

- [x] **Respect trial end** – When `trialEndsAt` is in the past and the business has no subscription, either: turn off auto-reply for that business, and/or show “Trial ended” and gate features until they subscribe.
- [x] **Trial ending soon** – Optional: email or in-app notice when trial has 7 (or 3) days left, with a link to `/subscribe`.

---

## Admin & security

- [ ] **Protect /admin** – Add basic auth, a secret query param, or login so only you can access the admin page.
- [x] **Admin: trial & subscription** – In the admin table, show `trialEndsAt` and subscription status (e.g. “Subscribed” / “Trial” / “Expired”), and optionally filter or sort by it.

---

## Product & UX

- [ ] **Subscribe page copy** – Replace placeholder price/description with your real plan (and add a second plan like “Pro” if you want).
- [x] **Connected page after subscribe** – If you use Stripe success_url to `/connected`, show a one-time “Thanks for subscribing” message when `?subscribed=1` is present.
- [ ] **Rate limiting** – Add simple rate limiting on `/auth/google`, `/free-reply`, and API routes to reduce abuse.

---

## Docs & ops

- [ ] **Env reference** – In README, list all env vars: `DATABASE_URL`, `GOOGLE_*`, `REPLYR_CONTACT`, `SUBSCRIBE_URL`, `SUBSCRIBE_PRICE`, `STRIPE_CUSTOMER_PORTAL_URL`, etc.
- [ ] **Logging** – Optionally add structured logs (or a single log line) for: OAuth connect, free-reply use, and Stripe webhook events to help with support and debugging.

---

## Replyr Pro – Customer marketing (promos, birthdays)

Replyr stays focused on review replies. Pro adds: businesses upload a customer list (CSV), we store it per business, and we send email campaigns (e.g. Mother’s Day promo, birthday message). Email only for now (opt-out compliant); SMS later only with explicit opt-in.

### Data: CSV upload & storage

- [x] **CSV upload flow** – Pro-only UI (e.g. on `/connected` or `/pro`) where the business can upload a CSV. Validate file type/size (e.g. max 5MB, `.csv` only).
- [x] **Required columns** – Define and document the minimum columns we need:
  - **Required:** `email` (so we can send and dedupe).
  - **Recommended:** `first_name` or `name` (for personalization), `birthday` or `birth_date` (for birthday campaigns; format e.g. `YYYY-MM-DD` or `MM/DD`).
  - **Optional:** `phone` (for future SMS if we add opt-in flow), `last_name`, custom fields.
- [x] **Column mapping UI** – Let the business map their CSV headers to our fields (e.g. “Email” → `email`, “Birthday” → `birthday`) so we accept different column names.
- [x] **Where we hold it** – Store per business, e.g.:
  - **Option A:** New DB table `pro_contacts` with `account_id`, `email`, `first_name`, `birthday`, `phone`, `unsubscribed_at`, `created_at`, unique on `(account_id, email)`.
  - **Option B:** One table for metadata (account_id, filename, row_count, last_uploaded_at) and a separate `pro_contact_rows` table for each row (account_id, email, normalized fields, unsubscribed_at). Prefer Option A for simplicity; add indexes on `account_id` and `email` for lookups and suppression.
- [x] **Replace vs append** – Decide: each upload replaces the list, or appends (with dedupe by email). Document in UI (“Uploading replaces your current list” or “New rows will be added; duplicates updated”).
- [x] **Unsubscribe list** – Store `unsubscribed_at` per (account_id, email). Before any send, exclude rows where `unsubscribed_at` is set. Never remove from DB so we don’t resend after opt-out.

### Campaigns & sending

- [x] **Campaign types (v1)** – (1) **One-off promo** – business picks a date, writes (or AI-generates) subject + body, we send to all non-unsubscribed contacts that day. (2) **Birthday message** – template (or AI) per contact; send on their birthday if we have `birthday`. Scheduler runs hourly.

- [x] **Pro prompts & confirmation (birthday)** – One settings flow on `/pro`: enable, message (Generate with Replyr or manual), offer. Save; used for all birthday sends until changed.

- [x] **Pro prompts & confirmation (events)** – Upcoming events on `/pro`; business opts in per event (Confirm/Skip). For each: set message and offer, then Confirm. Sends on event send date. No auto-send without confirmation.

- [x] **Email provider** – Resend (same key as alerts). From: “[Business] via Replyr”; Reply-To from business contact when available. `CAMPAIGN_FOOTER_ADDRESS` / `REPLYR_ADDRESS` for CAN-SPAM.

- [x] **Unsubscribe in every email** – Signed token in link; `GET /pro/unsubscribe?token=...` sets `unsubscribed_at`. Only that contact can opt out.

- [x] **Compliance copy** – “By uploading and sending you confirm…” in Pro UI; link to `/compliance`. Physical address in email footer when `CAMPAIGN_FOOTER_ADDRESS` set.

### Pro access & UX

- [x] **Pro gating** – CSV upload and campaigns only for `is_pro` businesses; “Upgrade to Pro” for others.
- [x] **Pro subscription** – Stripe Pro price; webhook sets `is_pro`; second plan on subscribe page.
- [x] **Pro dashboard** – `/pro` page: birthday settings, upcoming events (Confirm/Skip + message/offer), one-off schedule. “Manage campaigns” link on connected.

### Later / optional

- [ ] **Integrations** – Square, Fresha, etc. to pull contacts instead of CSV (same schema, different source).
- [ ] **SMS** – Only if we add explicit opt-in (e.g. “Text JOIN to …”). For Pro v1, email-only is enough.
- [ ] **Templates & AI** – Let business write promo body or use AI to generate from a short brief (e.g. “Mother’s Day 20% off nails”).

---

*Add new items here as you think of them.*
