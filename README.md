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
