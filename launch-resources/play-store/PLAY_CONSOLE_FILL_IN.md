# SEC Nightlife — Google Play Console Exact Fill-In Guide

Use this document to complete every required Play Console field for `com.secnightlife.app`.

**Package name (already created):** `com.secnightlife.app`  
**Canonical app name:** SEC Nightlife  
**Privacy policy:** https://secnightlife.com/PrivacyPolicy  
**Support:** support@secnightlife.com · https://secnightlife.com/HelpCenter

> **Reality check:** New personal developer accounts cannot publish straight to public download. Sequence: finish setup → upload signed AAB → closed test (12+ testers, 14 consecutive days) → apply for production → production release review → public download.

Related files in this folder:
- [`LISTING.md`](LISTING.md) — short/full description
- [`icon-512.png`](icon-512.png) · [`feature-graphic-1024x500.png`](feature-graphic-1024x500.png)
- [`screenshots/`](screenshots/)
- [`UPLOAD_AAB.md`](UPLOAD_AAB.md) — signed AAB path + upload steps
- [`REVIEWER_ACCOUNT.md`](REVIEWER_ACCOUNT.md)
- [`CLOSED_TESTING.md`](CLOSED_TESTING.md)
- [`tester-feedback-log.md`](tester-feedback-log.md)
- [`PRODUCTION_ACCESS.md`](PRODUCTION_ACCESS.md)

---

## Part A — Main store listing

**Path:** Grow → Store presence → Main store listing

| Field | Paste / upload |
|-------|----------------|
| App name | `SEC Nightlife` |
| Short description | `Discover restaurants, events & tables. Book nights out. Grow your venue.` |
| Full description | Block below |
| App icon (512×512) | [`icon-512.png`](icon-512.png) |
| Feature graphic (1024×500) | [`feature-graphic-1024x500.png`](feature-graphic-1024x500.png) |
| Phone screenshots | Upload from [`phone-screenshots/`](phone-screenshots/) (1080×1920) — see [`SCREENSHOTS_README.md`](SCREENSHOTS_README.md) |
| 7-inch tablet screenshots | Upload from [`tablet-7-inch-screenshots/`](tablet-7-inch-screenshots/) (optional, up to 8) |
| 10-inch tablet screenshots | Upload from [`tablet-10-inch-screenshots/`](tablet-10-inch-screenshots/) (optional, up to 8) |
| App category | **Entertainment** |
| Tags | nightlife, events, restaurants, tables, venues (closest available) |
| Email | `support@secnightlife.com` |
| Phone | Leave blank unless you have a dedicated support number |
| Website | `https://secnightlife.com` |
| Privacy policy | `https://secnightlife.com/PrivacyPolicy` |

### Full description (paste as-is)

```
SEC Nightlife is your all-in-one platform for going out — restaurants, bars, clubs, and live events.

Guests
• Discover places and events
• Book and join tables
• Host tables and events
• Friends, messages, and notifications

Venue owners
• Business dashboard and analytics
• Events, bookings, and menu management
• Promotions to grow your venue

Launching first in South Africa, built to expand worldwide.

Download SEC. Your Night. Simplified.
```

### Phone screenshot upload order

From [`phone-screenshots/`](phone-screenshots/) (max 8):

1. `01-home.png`
2. `02-profile.png`
3. `06-host-dashboard.png`
4. `01-dashboard.png`
5. `02-analytics.png`
6. `03-bookings.png`
7. `04-menu-food.png`
8. `03-messages.png`

Tablet: same filenames from `tablet-7-inch-screenshots/` and `tablet-10-inch-screenshots/`.

### Store settings

- Default language: English (United States) — en-US
- Countries / regions: start with **South Africa** (add more later)

---

## Part B — App content questionnaire

**Path:** Policy → App content (or Dashboard → Finish setting up your app)

### 1. Privacy policy

- URL: `https://secnightlife.com/PrivacyPolicy`

### 2. Ads

- **No** — this app does not contain ads

### 3. App access

- Select: **All or some functionality in my app is restricted**
- Paste instructions from [`REVIEWER_ACCOUNT.md`](REVIEWER_ACCOUNT.md) after you create the reviewer account

### 4. Content ratings (IARC)

Expected outcome: **Mature 17+** (alcohol / nightlife).

| Topic | Answer |
|-------|--------|
| Violence | No |
| Sexual content / nudity | No |
| Language | Mild / infrequent if asked; otherwise No |
| Controlled substances | **Yes — alcohol references / alcohol-related nightlife content** |
| Gambling | No |
| User interaction | **Yes** — users can communicate / exchange UGC |
| Users can share location | **Yes** |
| Users can purchase goods or services | **Yes** — tickets, tables, bookings, boosts via Paystack |
| Unrestricted web access | No |
| Typical age | **18+** |

### 5. Target audience and content

- Target age groups: **18 and over only**
- Attractiveness to children: **No**
- Store presence appeal to children: **No**

### 6. News apps

- **No**

### 7. COVID-19 contact tracing / status apps

- **No**

### 8. Data safety

**Overall**

| Question | Answer |
|----------|--------|
| Does your app collect or share user data? | **Yes** |
| Is all user data encrypted in transit? | **Yes** (HTTPS) |
| Do you provide a way for users to request that their data is deleted? | **Yes** — Settings → Delete account; also `support@secnightlife.com` |

**Data types** (declare collected; shared with service providers / other users as needed for the feature — **not sold**):

| Data type | Collected | Shared | Purpose | Required? | Ephemeral |
|-----------|-----------|--------|---------|-----------|-----------|
| Name | Yes | Yes | App functionality, account management | Required for account | No |
| Email address | Yes | Yes | App functionality, account management | Required | No |
| User IDs | Yes | Yes | App functionality | Required | No |
| Photos | Yes | Yes | App functionality | Optional | No |
| Other user-generated content | Yes | Yes | App functionality | Optional | No |
| Messages | Yes | Yes | App functionality | Optional | No |
| Approximate location | Yes | Yes | App functionality | Optional | No |
| Precise location | Yes (when enabled) | Yes | App functionality | Optional | No |
| Purchase history | Yes (metadata; not full card) | Yes (Paystack) | App functionality | Optional (needed to pay) | No |
| Other financial info (bank payout details) | Yes | Yes (Paystack) | App functionality | Optional | No |
| Device or other IDs (push tokens) | Yes | Yes (FCM) | App functionality, notifications | Optional | No |
| App interactions | Yes | No (first-party) | Analytics | Optional | No |
| Crash logs (if Sentry enabled) | Yes | Yes (Sentry) | App functionality / stability | Optional | No |

Also answer:

- Data sold: **No**
- Data used for advertising / advertising ID: **No**
- Data used for fraud prevention, security, and compliance: **Yes** (where applicable)

### 9. Government apps

- **No**

### 10. Financial features

- Declare **payments / paid bookings / wallet payouts** processed by **Paystack**
- Not a bank or neobank
- Not Google Play Billing IAP for digital goods
- Crypto: **No**

### 11. Health

- **No**

### 12. Permissions

- Notifications (`POST_NOTIFICATIONS`): yes
- If asked about advertising ID: app does **not** use advertising ID for ads

### 13. Advertising ID

- **No** / app does not use advertising ID

### 14. User-generated content

- **Yes** — profiles, photos, messages, event/table content
- Moderation: in-app report/block + Community Guidelines  
  `https://secnightlife.com/CommunityGuidelines`

### 15. Children / Families

- Not designed for children; **18+ only**

---

## Part C — Build & upload prerequisites

1. Create release keystore (one-time) — see [`sec-night-life/docs/ANDROID_RELEASE_SIGNING.md`](../../sec-night-life/docs/ANDROID_RELEASE_SIGNING.md)
2. Build signed AAB (`versionName 1.0`, `versionCode 6`)
3. Create Play reviewer account — [`REVIEWER_ACCOUNT.md`](REVIEWER_ACCOUNT.md)
4. Confirm privacy URL loads: https://secnightlife.com/PrivacyPolicy

From `sec-night-life/`:

```bash
npm run android:keystore   # one-time, interactive
npm run android:aab        # builds signed release AAB when keystore.properties exists
```

---

## Part D — Closed testing

Follow [`CLOSED_TESTING.md`](CLOSED_TESTING.md).

Minimum gate: **12 testers opted-in for 14 consecutive days**.

---

## Part E — Production access questionnaire

After the 14-day closed test, use draft answers in [`PRODUCTION_ACCESS.md`](PRODUCTION_ACCESS.md).

---

## Done when

- [ ] Main store listing saved with graphics + descriptions
- [ ] All App content declarations complete (no required tasks left)
- [ ] Reviewer credentials entered under App access
- [ ] Signed AAB uploaded to Closed testing and rolled out
- [ ] 12+ testers opted-in for 14 consecutive days
- [ ] Production access approved
- [ ] Production release submitted and approved for public download
