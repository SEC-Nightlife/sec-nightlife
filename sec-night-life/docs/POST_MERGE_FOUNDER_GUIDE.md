# After merge — founder launch steps (payments + performance)

Do this **after** the launch-hardening PR is deployed. Keep Paystack on **test keys** until step 6 passes.

## What you pay for (speed + reliability)

| Order | Service | Approx. | Why |
|------|---------|---------|-----|
| 1 | **Neon Scale** | ~$19+/mo | Faster Home + Analytics; more DB connections (yes — paying for the database helps) |
| 2 | **Vercel Pro** | ~$20/mo | Reliable cron (`retry-payouts`, promotions) for both projects |
| 3 | **Upstash Redis** | ~$10–30/mo | Home feed cache + distributed rate limits (code is ready) |
| 4 | **Resend** | free → ~$20/mo | OTP / refund emails at volume |
| 5 | **Cloudinary** | usage | Images (lock unsigned preset) |
| 6 | **Google Maps** | pay-as-you-go | Map pins |
| 7 | **Apple + Play** | $99/yr + $25 | Store apps |
| Later | **Pusher** | ~$49+/mo | Chat real-time only — **not** needed for Home/Analytics speed |
| Optional | **Sentry** | free tier | Crash monitoring |

**Home + Analytics priority:** Neon Scale → Upstash → Vercel Pro → Pusher last.

---

## Step-by-step

### 1. Neon (database)

1. Open [Neon console](https://console.neon.tech) → your project.
2. Confirm **pooled** `DATABASE_URL` and **direct** `DIRECT_DATABASE_URL` are set on the **API** Vercel project.
3. Run migrations on production:
   ```bash
   cd backend && npx prisma migrate deploy
   ```
4. When you see timeouts or slow Analytics/Home under load → upgrade to **Neon Scale**.

### 2. Vercel (two projects — required)

| Project | Domain | Root Directory | Role |
|---------|--------|----------------|------|
| **`sec-nightlife`** | `secnightlife.com` | `sec-night-life` | Vite SPA only (`dist/`) |
| **`sec-nightlife-2io4`** | `api.secnightlife.com` | `sec-night-life/backend` | Express API |

**If the frontend card says “No Production Deployment”:** open `sec-nightlife` → ensure Root Directory is `sec-night-life`, Framework Vite, Output `dist`, then **Redeploy → Production**. Do **not** point the frontend project at `backend/`. Local CLI `.vercel/project.json` must link to the **frontend** project when deploying the SPA (not `sec-nightlife-2io4`).

1. Upgrade to **Pro** if cron or limits are flaky.
2. API project env (Production):
   - `NODE_ENV=production`
   - `CORS_ORIGIN=https://secnightlife.com`
   - `APP_URL=https://secnightlife.com`
   - **Do not** set `CORS_ALLOW_VERCEL_PREVIEW` in production
   - **Unset** `SKIP_EMAIL_VERIFICATION` / `ALLOW_UNVERIFIED_LOGIN`
   - `CRON_SECRET` set
   - **Region:** set Functions region to match Neon (e.g. `fra1` if Neon is Frankfurt)
3. Frontend project: `VITE_API_URL=https://api.secnightlife.com`, `VITE_PUBLIC_APP_URL=https://secnightlife.com`, Cloudinary, Maps.
4. Redeploy **both** projects after env changes. Confirm frontend dashboard shows a Production deployment (not “No Production Deployment”).
5. Confirm cron includes `/api/cron/retry-payouts` and `/api/cron/repair-payment-fulfillment`.

### 3. Upstash Redis (performance — required for paid speed)

1. Create a Redis database at [upstash.com](https://upstash.com) in the **same region as Neon** (e.g. Frankfurt/EU — not Cape Town if Neon is EU).
2. Copy **REST URL** + **REST TOKEN**.
3. Set on **API** Vercel Production (not frontend):
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Redeploy API. Home bootstrap/feed cache, auth user cache, and Redis rate limits activate automatically.
5. Confirm in Upstash console that keys appear after loading Home once (e.g. `home:bootstrap:*`, `auth:user:*`).

### 4. Cloudinary hardening

1. Cloudinary → Settings → Upload → your unsigned preset.
2. Restrict: folder `sec-nightlife`, allowed formats PDF/JPG/PNG, max file size ~15MB.
3. Keep `CLOUDINARY_*` on API; `VITE_CLOUDINARY_*` on frontend.

### 5. Deep links + native

1. Replace `FOUNDER_ANDROID_SHA256_FINGERPRINT` in `public/.well-known/assetlinks.json`.
2. Replace `FOUNDER_APPLE_TEAM_ID` in `public/.well-known/apple-app-site-association`.
3. Rebuild + upload native apps.
4. iOS: enable **Push Notifications** capability; set APNs key in Firebase; ensure release `aps-environment` is `production`.
5. Set `FIREBASE_SERVICE_ACCOUNT_JSON` on API for FCM delivery.
6. Run: `npm run verify:production` — must fail until deep-link placeholders are gone.

### 6. Paystack (switch to live only when ready)

**Refund model (locked):** venue still pays guests **off-app** via Sec Wallet lookup (reveal full account when paying a refund). No Paystack card refund API / no transfer clawback.

1. Complete Paystack business activation (see `launch-resources/paystack/`).
2. Enable **Transfers** on the live account.
3. Confirm **Settings → Preferences → Payout schedule = Settled to Balance** (not auto bank payout). **Enabled 5 Aug 2026** (Chika) — keep Transfer Approval / OTP confirm off. Next: Topup or wait for Available, then venue Transfers clear Pending. Details: `launch-resources/paystack/SETTLE_TO_BALANCE_MARKETPLACE.md`.
4. Set matching live keys:
   - API: `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`
   - Frontend: `VITE_PAYSTACK_PUBLIC_KEY` (or rely on API public-key endpoint) — redeploy frontend
5. Webhook URL (live dashboard): `https://api.secnightlife.com/api/webhooks/paystack`  
   Subscribe at least: `charge.success`, `charge.failed`, `transfer.success`, `transfer.failed`, `transfer.reversed`, dispute events if offered.
6. Small live E2E (only after Available receives settlements):
   - Buy ticket → QR appears
   - Confirm venue/host payout ledger moves to `PROCESSING` then `TRANSFERRED`
   - Request refund → venue approves → venue reveals wallet account → marks paid off-app
7. Ops: chargebacks are handled in Paystack dashboard + `SUPER_ADMIN_EMAIL` notice; failed transfers retry via cron.

### 7. Smoke tests

Use [LAUNCH_CHECKLIST.md](./LAUNCH_CHECKLIST.md): guest Home, register/OTP, ≤5 API Home calls, map pins, chat poll, push token, cron logs.

### 8. Store listings

Upload assets from `launch-resources/`, privacy URL `https://secnightlife.com/PrivacyPolicy`, support `https://secnightlife.com/HelpCenter`, age 17+/Mature nightlife.

---

## Already done in code (this launch hardening)

- Unique payout ledger + transfer webhooks + retry cron
- Manual-refund ledger honesty (`REFUNDED_MANUAL`)
- Boost/listing amount validation
- Dispute webhook notify + metadata flag
- Recipient code only via payout-recipient API
- Masked wallet lookup + explicit reveal
- Soft-retain payments/refunds on account delete
- Legal API points to lawyer frontend pages (no stubs)
- Cookie Policy + browser notice; guest 18+ gate
- CORS tightened; data export in Settings
- Upstash-ready feed cache + Redis rate limits
- Analytics/home query caps; home venue social proof
- iOS privacy strings; verify-production rejects deep-link placeholders
