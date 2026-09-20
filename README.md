# Secure Notes — sell your PDF as protected online content

A self-hosted platform that converts your PDF study material into online pages that are:

- **Sold** — customers register and pay; access is granted per title with optional expiry.
- **Bound to one device per account** — the first sign-in binds a device; any other device is blocked. A password-protected **“Move to this device”** flow re-binds and instantly kills the old device.
- **One active session per account** — logging in signs out the previous session.
- **Not downloadable** — the original PDF is never sent to the browser. Pages are rendered server-side into images served only through short-lived, session-checked tokens.
- **Watermarked per buyer** — every page carries a repeating overlay naming the licensed user, so a shared screenshot is traceable.
- **Protected against ordinary copying** — right-click, drag, copy and print are disabled (screenshots/recording cannot be fully prevented — see [Limits](#limits)).

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure (edit .env)
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=aStrongPassword123

# 3. Create the admin account (once)
npm run seed

# 4. Run
npm start
```

Open:

- Store/library for customers:  `http://localhost:PORT`
- Admin panel:                  `http://localhost:PORT/admin/login`

Flow to run it once end-to-end:

1. Sign in to `/admin/login` (your `ADMIN_EMAIL`/`ADMIN_PASSWORD`).
2. Admin → **Content** → upload a PDF (title, price, access days).
3. Wait a few seconds for pages to render (status shows **Live**).
4. As a normal visitor: register, sign in (the phone is now *bound*), open the title, **Buy access**, pay on the mock checkout.
5. The reader opens page 1 with the buyer’s watermark.

There is also a bundled sample generator and smoke test:

```bash
npm run make-demo-pdf               # creates data/uploads/demo.pdf (6 pages)
npm run smoke-test                  # full end-to-end check against a running server
```

and a CLI uploader:

```bash
npm run upload-pdf -- file.pdf "My Course Notes" 9.99 30
```

---

## What each protection actually does

| Threat | Protection in this app |
|---|---|
| Sharing the login | Device binding: account works on **one** device. A second login is rejected (`device_mismatch`). |
| Moving to a new phone | `/transfer` (password required) re-binds the account; every session of the old device is revoked instantly. |
| Two people logged in at once | Single-active-session: each login revokes all earlier sessions of the account. |
| Downloading the PDF | The file is never served — only re-rendered page images. No route exposes the original PDF. |
| Saving page images | Images require a valid session **plus** an active license **plus** a 5-minute HMAC token; responses are `no-store`. |
| Copying text / screenshots | Pages are images; readers get right-click/drag/copy/print disabled and a per-buyer overlay watermark on every page. |
| Brute-forcing passwords | 5 failed logins per email/IP → 15-minute lockout. |
| Forged “paid” notifications | Payment webhooks require a server-side shared `WEBHOOK_SECRET`. |

## Device / session model

1. On **first successful sign-in**, the server issues a one-time device token. The client stores it in the browser’s `localStorage` (`hrh_device_token`).
2. On **every later sign-in**, the browser must present that token; the server compares its SHA-256 hash.
3. Token gone (cleared browser data)? Use the **Move to this device** page to re-bind with your password — the previous device is invalidated. Or ask the seller (admin) to click **Clear bound device**.
4. That is the whole model: the account has exactly one authorized device at any time.

## Payments

The app ships with a **demo checkout** so you can test the entire flow offline.

To accept real money, point your payment provider at the webhook. Any provider that can POST to a URL works (PayFast, Stripe, Razorpay, Paystack, …). Send a JSON body:

```
POST {BASE_URL}/api/webhook/payment
{
  "secret":      "<WEBHOOK_SECRET from .env>",   // your shared signing secret
  "reference":   "HRH-XXXXXXXX",                  // unique order id shown at checkout
  "provider":    "stripe",
  "trans_id":    "pay_123",
  "status":      "completed",                     // completed|paid|success|settled
  "amount_cents": 999
}
```

On a paid status the license is granted/refreshed and the buyer can read. Always answers `200` (idempotent; repeated webhooks are harmless). Generate a strong secret:

```bash
npm exec node -- -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set it in `.env` as `WEBHOOK_SECRET`. In production keep the old checkout screen but replace the “Pay now” handler so the buyer is redirected to your real gateway with the order `reference`.

## Access expiry

- Each title has an access duration at upload time (`0` = lifetime).
- A license ends (status `expired`) after the duration; the reader stops serving pages.
- Renewal = buying again or an admin granting/extending from the user page.

## Admin panel

`/admin/login` →

- **Dashboard** — customers, active licenses, titles, revenue, activity log (auto-refresh).
- **Customers** — search; per user: enable/disable (signs out everywhere), clear bound device (lost-phone recovery), reset password, grant/revoke access per title with configurable days.
- **Content** — upload a PDF (price, lifetime/`N` days), publish/hide, reprocess. The original PDF is stored only for reprocessing; pages are rendered independently.

## Production deployment

```bash
# Typical: Caddy/nginx provides HTTPS in front of this Node app
PORT=3000
BASE_URL=https://notes.example.com
TRUST_PROXY=1           # cookies become Secure, respect X-Forwarded-For
WEBHOOK_SECRET=<long random string>
```

- Put it behind an HTTPS reverse proxy (Caddy or nginx) and set `TRUST_PROXY=1`. Cookies are `HttpOnly` and flagged `Secure` in this mode.
- Run it supervised: `pm2 start server.js`, a systemd service, or any process manager.
- Keep `DATA_DIR` on a persistent disk; back it up (SQLite + `data/pages` + `data/uploads/+covers`).
- For large PDFs raise `RENDER_SCALE` is fine, but reprocessing happens in the background, so the app stays responsive.
- Point your real payment provider at the webhook (above).

## Files & API

```
server.js          app entry, headers, routes
lib/config.js      env + persistent app secret (data/.secret)
lib/db.js          SQLite schema (users, sessions, books, licenses, purchases, audit)
lib/auth.js        passwords, single-active sessions, device binding, rate limiting
lib/licenses.js    purchase/webhook verify + grant/extend/expire
lib/pdf.js         mupdf render: PDF -> per-page PNG + cover (source never served)
lib/tokens.js      per-buyer watermark + 5-minute HMAC page tokens
routes/…           auth, pages/reader, purchase/webhook, admin
views/…            EJS (mobile-first)
scripts/…          seed, demo-pdf, upload-pdf, smoke-test
```

Main endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/register` · `POST /api/login` | account creation; login with `X-Device-Token` header |
| `POST /api/device/transfer` | password-protected device re-bind (kills old device) |
| `GET /library` | catalog + your licenses |
| `GET /book/:id` · `GET /book/:id/page/:n` | details / reader (watermarked, no-copy) |
| `GET /page-img/:id/page/:n?tk=…` | tokenized page image |
| `POST /api/purchase` · `GET /checkout/:ref` | order + demo checkout |
| `POST /api/webhook/payment` | real payment verification |
| `GET|POST /admin/…` | admin panel |

## Limits (read this before you sell)

1. **Screenshots** cannot be stopped. The watermark makes leaks traceable, not impossible. Add your own grading/homework protection if content must not be shared at all.
2. **Screen recording** and camera pics of the screen can’t be blocked by any web app.
3. A determined user can use browser tools to fetch the page images; the per-buyer watermark is your recourse.
4. Watermark identity + short tokens make casual sharing painful, but this is **content protection, not mathematical DRM**. Publish your terms, watermark aggressively, and use the admin audit log if copies appear online.

## Development notes

- Zero native modules: SQLite is Node’s built-in `node:sqlite`; PDF rendering uses mupdf (WASM).
- Requires **Node 22+** (tested on Node 24).
- The app deliberately has **no** endpoint that serves the uploaded PDF.