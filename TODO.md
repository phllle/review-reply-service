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

*Add new items here as you think of them.*
