# SEC Nightlife — Founder Software Setup Guide

Step-by-step guide for every service you need to launch SEC on **secnightlife.com**, the **App Store**, and **Google Play**.

**Production domains (live):**

| Role | URL |
|------|-----|
| Frontend | https://secnightlife.com |
| Backend API | https://api.secnightlife.com |

---

## Cost summary (launch)

| Service | Cost | Required when |
|---------|------|----------------|
| **Apple Developer Program** | $99/year | iOS App Store |
| **Google Play Console** | $25 one-time | Android Play Store |
| **Domain (GoDaddy)** | ~$10–20/year | Already owned |
| **Vercel** | Free → **$20/mo Pro** recommended | Hosting (2 projects) |
| **Neon PostgreSQL** | Free → **$19+/mo Scale** | Database (upgrade before heavy traffic) |
| **Resend** | Free tier → ~$20/mo | Email (OTP, verification) |
| **Cloudinary** | Free tier → usage-based | Images / uploads |
| **Google Maps** | Pay-as-you-go | Map + address autocomplete |
| **Firebase** | Free | Push notifications |
| **Paystack** | Per transaction | Live payments |
| **Sentry** (optional) | Free tier | Error monitoring |

**Post-launch scale (optional):**

| Service | Est. cost | Purpose |
|---------|-----------|---------|
| Upstash Redis | $10–30/mo | Feed caching + distributed rate limits (wired in API) |
| Pusher | $49+/mo | Real-time chat |

**After deploying launch hardening, follow:** [POST_MERGE_FOUNDER_GUIDE.md](./POST_MERGE_FOUNDER_GUIDE.md)

---

## Master checklist (in order)

- [ ] **1. Vercel** — env vars + redeploy both projects
- [ ] **2. Neon** — confirm DB healthy + migrations
- [ ] **3. GoDaddy DNS** — verify custom domains (mostly done)
- [ ] **4. Resend** — verify `secnightlife.com` for email
- [ ] **5. Cloudinary** — founder account + upload preset
- [ ] **6. Google Maps** — restrict API key to your domain
- [ ] **7. Firebase** — FCM + service account for backend push
- [ ] **8. Paystack** — live keys + webhook (after approval)
- [ ] **9. Android keystore** — create + SHA-256 for App Links
- [ ] **10. Google Play Console** — register + upload AAB
- [ ] **11. Apple Developer** — register + Team ID + upload IPA
- [ ] **12. Store listings** — upload assets from `launch-resources/`
- [ ] **13. Smoke test** — register → verify → buy ticket → delete account

---

## 1. Vercel (frontend + backend)

You have **two** Vercel projects:

| Project | Domain |
|---------|--------|
| `sec-night-life` | secnightlife.com |
| `sec-night-life-2io4` | api.secnightlife.com |

### Frontend env (Production)

Set in **sec-night-life** → Settings → Environment Variables → **Production**:

```env
VITE_API_URL=https://api.secnightlife.com
VITE_PUBLIC_APP_URL=https://secnightlife.com
VITE_CLOUDINARY_CLOUD_NAME=your_cloud_name
VITE_CLOUDINARY_UPLOAD_PRESET=sec_unsigned_uploads
VITE_GOOGLE_MAPS_API_KEY=your_browser_key
```

Optional: `VITE_PAYSTACK_PUBLIC_KEY`, `VITE_SENTRY_DSN`

**Important:** `VITE_*` vars are baked at **build time**. After changing them, click **Redeploy** on the frontend project.

### Backend env (Production)

Set in **sec-night-life-2io4** → Settings → Environment Variables → **Production**:

```env
NODE_ENV=production
DATABASE_URL=postgresql://...@...-pooler.neon.tech/...
DIRECT_DATABASE_URL=postgresql://...@....neon.tech/...
JWT_ACCESS_SECRET=<64+ char random hex>
JWT_REFRESH_SECRET=<different 64+ char random hex>
CORS_ORIGIN=https://secnightlife.com
APP_URL=https://secnightlife.com
RESEND_API_KEY=re_...
EMAIL_FROM=SEC Nightlife <noreply@secnightlife.com>
CRON_SECRET=<random string — same in Vercel Cron auth>
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
SUPER_ADMIN_EMAIL=your@email.com
```

When Paystack is live:

```env
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_PUBLIC_KEY=pk_live_...
```

For push delivery (optional until native app is live):

```env
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

**Must NOT be set in production:**

- `SKIP_EMAIL_VERIFICATION`
- `ALLOW_UNVERIFIED_LOGIN`

### Redeploy after code changes

1. Push to your connected Git branch, **or**
2. Vercel dashboard → Deployments → **Redeploy** (both projects)

### Verify after deploy

From `sec-night-life/`:

```bash
npm run verify:production
```

Or manually:

```bash
curl https://api.secnightlife.com/api/health/ready
curl https://secnightlife.com/.well-known/assetlinks.json
curl -sI https://secnightlife.com/.well-known/apple-app-site-association
```

See also: [VERCEL_ENV_FRONTEND.md](./VERCEL_ENV_FRONTEND.md), [VERCEL_ENV_BACKEND.md](./VERCEL_ENV_BACKEND.md)

---

## 2. Neon (PostgreSQL)

1. Log in at [neon.tech](https://neon.tech)
2. Open your SEC project
3. Confirm **DATABASE_URL** uses the **pooler** host (`-pooler` in hostname) for Vercel backend
4. Set **DIRECT_DATABASE_URL** to the non-pooler connection string (for migrations)

Migrations run automatically on backend deploy via `scripts/vercel-build.mjs`.

Verify DB:

```bash
curl https://api.secnightlife.com/api/health/ready
# Expect: {"status":"ready","db":"ok",...}
```

**When to upgrade:** connection timeouts, slow queries, or >1k active users → Neon **Scale** (~$19+/mo).

---

## 3. GoDaddy / DNS

Your domains should already point to Vercel. Re-check:

- `secnightlife.com` → Vercel frontend
- `www.secnightlife.com` → same (optional)
- `api.secnightlife.com` → Vercel backend

See [CUSTOM_DOMAIN_DNS.md](./CUSTOM_DOMAIN_DNS.md) for record types.

---

## 4. Resend (email)

1. Sign up at [resend.com](https://resend.com)
2. **Domains** → Add `secnightlife.com`
3. Add DNS records Resend shows (SPF, DKIM) at GoDaddy
4. Wait for verification
5. Create API key → set `RESEND_API_KEY` on backend Vercel
6. Set `EMAIL_FROM=SEC Nightlife <noreply@secnightlife.com>`
7. Redeploy backend

Test: register a new account and confirm verification email arrives.

---

## 5. Cloudinary (images)

1. Sign up at [cloudinary.com](https://cloudinary.com) with your business email
2. Copy **Cloud Name**, **API Key**, **API Secret**
3. **Settings → Upload → Upload presets → Add:**
   - Name: `sec_unsigned_uploads`
   - Signing: **Unsigned**
   - Folder: `sec-nightlife`
4. Set env on **both** Vercel projects (see section 1)
5. Redeploy both

Test: venue onboarding logo upload.

---

## 6. Google Maps

1. [Google Cloud Console](https://console.cloud.google.com) → APIs & Services
2. Enable **Maps JavaScript API** and **Places API**
3. Create **Browser key** restricted to:
   - HTTP referrers: `https://secnightlife.com/*`, `http://localhost:*`
4. Set `VITE_GOOGLE_MAPS_API_KEY` on frontend Vercel → redeploy

For native apps later, add Android package + iOS bundle restrictions.

---

## 7. Firebase (push notifications)

1. Project: `sec-nightlife-55ed4` (already configured)
2. Config files: `android/app/google-services.json`, `ios/App/App/GoogleService-Info.plist`
3. **Backend push:** Firebase Console → Service accounts → Generate private key → set `FIREBASE_SERVICE_ACCOUNT_JSON` on backend Vercel
4. **iOS:** After Apple Developer account → upload APNs key to Firebase Cloud Messaging

Full steps: [FIREBASE_PUSH_SETUP.md](./FIREBASE_PUSH_SETUP.md)

---

## 8. Paystack (live payments)

**After Paystack approves your merchant account:**

1. Backend Vercel: `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`
2. Frontend Vercel: `VITE_PAYSTACK_PUBLIC_KEY` → redeploy frontend
3. Paystack dashboard → Webhooks:
   ```
   https://api.secnightlife.com/api/webhooks/paystack
   ```
4. Enable events: `charge.success`, `charge.failed`
5. Run end-to-end test: small ticket purchase → QR in Profile

See: `launch-resources/paystack/LIVE_KEYS_CHECKLIST.md`

---

## 9. Android release keystore + App Links

### Create keystore (one time — **back up safely**)

```bash
keytool -genkey -v -keystore sec-release.keystore -alias sec-nightlife -keyalg RSA -keysize 2048 -validity 10000
```

Store the keystore file and passwords in a password manager. **If you lose it, you cannot update the Play Store app.**

### Get SHA-256 for App Links

```bash
keytool -list -v -keystore sec-release.keystore -alias sec-nightlife
```

Copy the **SHA-256** fingerprint (colon-separated format).

### Update assetlinks.json

Edit `sec-night-life/public/.well-known/assetlinks.json`:

Replace `FOUNDER_ANDROID_SHA256_FINGERPRINT` with your SHA-256.

Redeploy **frontend** Vercel project.

---

## 10. Google Play Console ($25 one-time)

**Exact paste-ready answers:** [`launch-resources/play-store/PLAY_CONSOLE_FILL_IN.md`](../../launch-resources/play-store/PLAY_CONSOLE_FILL_IN.md)

1. Register at [play.google.com/console](https://play.google.com/console)
2. Create app **SEC Nightlife** (`com.secnightlife.app`)
3. Complete store listing + App content using the fill-in guide (icon, feature graphic, screenshots, privacy URL, data safety, 18+)
4. Build signed AAB:
   ```bash
   cd sec-night-life
   npm run android:keystore   # one-time — back up passwords
   npm run android:aab
   ```
   Or Android Studio → Generate Signed Bundle → **AAB** (see [ANDROID_RELEASE_SIGNING.md](./ANDROID_RELEASE_SIGNING.md))
5. Upload to **Closed testing** (required): 12+ opted-in testers for 14 days — [`CLOSED_TESTING.md`](../../launch-resources/play-store/CLOSED_TESTING.md)
6. Apply for production access — [`PRODUCTION_ACCESS.md`](../../launch-resources/play-store/PRODUCTION_ACCESS.md)

Age rating: **17+ / Mature** (alcohol / nightlife content). Public production is locked until closed testing completes.

---

## 11. Apple Developer ($99/year)

1. Register at [developer.apple.com](https://developer.apple.com)
2. Copy **Team ID** from Membership page
3. Update `sec-night-life/public/.well-known/apple-app-site-association`:
   - Replace `FOUNDER_APPLE_TEAM_ID` with your Team ID
   - Format: `"appID": "TEAMID.com.secnightlife.app"`
4. Redeploy frontend
5. Build iOS app (requires macOS + Xcode):
   ```bash
   cd sec-night-life
   npm run build:mobile
   npm run cap:ios
   ```
6. Xcode → Signing team → Product → Archive → App Store Connect
7. App Store Connect listing using `launch-resources/app-store/`

Associated Domains are in `ios/App/App/App.entitlements` (`applinks:secnightlife.com`).

---

## 12. Store assets quick reference

| Asset | Location |
|-------|----------|
| App Store icon 1024×1024 | `launch-resources/app-store/icon-1024.png` |
| Play icon 512×512 | `launch-resources/play-store/icon-512.png` |
| Legal URLs | `launch-resources/legal/LEGAL_URLS.md` |
| Listing copy | `launch-resources/app-store/LISTING.md`, `play-store/LISTING.md` |

Regenerate screenshots:

```bash
cd sec-night-life
npm run launch:capture
npm run launch:generate-assets
```

---

## 13. Production smoke test

After every deploy:

1. **Guest** opens https://secnightlife.com — splash, no login required
2. **Register** → verify email → login OTP → Home loads
3. **Map** shows pins
4. **Messages** load (if applicable)
5. **Settings → Delete account** works
6. Native app: push token registers (device + Firebase configured)

Automated check:

```bash
cd sec-night-life && npm run verify:production
```

---

## Post-launch scale (10k+ users)

When you feel slowness or hit Vercel/Neon limits:

1. **Neon Scale** — more compute + connections
2. **Vercel Pro** — higher limits, team features
3. **Upstash Redis** — cache home feed (engineering task)
4. **Pusher** — replace chat polling with WebSockets
5. Load-test `/api/home/bootstrap` and `/api/home/feed`

See [PERFORMANCE.md](./PERFORMANCE.md) and [LAUNCH_CHECKLIST.md](./LAUNCH_CHECKLIST.md).

---

## Related docs

- [CAPACITOR_BUILD.md](./CAPACITOR_BUILD.md) — native build details
- [FOUNDER_LAUNCH_HANDOFF.md](./FOUNDER_LAUNCH_HANDOFF.md) — credential transfer
- [LAUNCH_CHECKLIST.md](./LAUNCH_CHECKLIST.md) — pre-launch verification
- [launch-resources/README.md](../../launch-resources/README.md) — store assets
