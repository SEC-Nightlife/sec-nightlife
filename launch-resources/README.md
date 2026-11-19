# SEC Nightlife — Launch Resources

Everything needed to submit SEC to the **Apple App Store**, **Google Play Store**, and complete **Paystack live activation**.

**Live app:** https://secnightlife.com

---

## Folder structure

| Folder | Contents |
|--------|----------|
| [`app-store/`](app-store/) | 1024×1024 icon, resized screenshots (1290×2796), listing copy template |
| [`play-store/`](play-store/) | 512 icon, feature graphic, **phone + tablet screenshot folders**, listing copy, Play Console fill-in guide |
| [`screenshots/mobile/`](screenshots/mobile/) | Source mobile captures (390×844 @3x) — party-goer & business-owner |
| [`legal/`](legal/) | Exported legal page PNGs + [`LEGAL_URLS.md`](legal/LEGAL_URLS.md) for store forms |
| [`paystack/`](paystack/) | Payment demo video, activation email draft, payment flows reference |
| [`brand/`](brand/) | Logos and brand guide |
| [`copy/`](copy/) | Taglines and messaging |
| [`scripts/`](scripts/) | Capture and export automation |

---

## Capture store screenshots (your accounts)

From `sec-night-life/`:

```bash
npm run launch:capture
```

A **visible browser** opens on production. You log in twice:

1. **Business Owner** — sign in (complete OTP if asked). The script **automatically opens Business Dashboard** — you do not need the nav bar. Optional direct link: `https://secnightlife.com/BusinessDashboard`
2. **Party-Goer** — sign in after logout, press **Enter** when on Home (or create `launch-resources/scripts/.continue-party`)

### Screenshots captured

**Party-goer:** Home, Profile, Messages, Notifications, Friends, Host Dashboard

**Business owner:** Dashboard, Analytics, Bookings, Menu (Food tab)

---

## Export legal documents

```bash
npm run launch:export-legal
```

Exports all Settings → Support legal pages as PNGs and updates `legal/LEGAL_URLS.md`.

---

## Paystack activation demo

```bash
npm run launch:paystack-demo
```

Log in as party-goer, complete a **test ticket purchase**, then press Enter. Output: `paystack/payment-demo-ticket.mp4`

See [`paystack/EMAIL_TO_PAYSTACK.md`](paystack/EMAIL_TO_PAYSTACK.md) for the email to send with the video.

---

## Generate icons & resize screenshots

```bash
npm run launch:generate-assets
```

Creates App Store / Play Store icons, feature graphic, and resizes mobile screenshots into `app-store/screenshots/` and Play folders.

Play phone + tablet crops from App Store assets:

```bash
node launch-resources/scripts/generate-play-screenshots.mjs
```

Outputs:
- `play-store/phone-screenshots/` (1080×1920)
- `play-store/tablet-7-inch-screenshots/` (1200×1920)
- `play-store/tablet-10-inch-screenshots/` (1600×2560)

---

## Package for sharing

```bash
zip -r sec-launch-resources.zip launch-resources/
```

PowerShell:

```powershell
Compress-Archive -Path launch-resources -DestinationPath sec-launch-resources.zip -Force
```

---

## Google Play Console (exact answers)

Open and follow in order:

1. [`play-store/PLAY_CONSOLE_FILL_IN.md`](play-store/PLAY_CONSOLE_FILL_IN.md) — store listing + app content answers  
2. [`play-store/REVIEWER_ACCOUNT.md`](play-store/REVIEWER_ACCOUNT.md) — App access credentials  
3. [`play-store/UPLOAD_AAB.md`](play-store/UPLOAD_AAB.md) — upload the signed AAB  
4. [`play-store/CLOSED_TESTING.md`](play-store/CLOSED_TESTING.md) — 12 testers / 14 days  
5. [`play-store/PRODUCTION_ACCESS.md`](play-store/PRODUCTION_ACCESS.md) — production questionnaire drafts  

From `sec-night-life/`:

```bash
npm run android:keystore   # one-time (already done on this machine if keystore exists)
npm run android:aab        # signed Play upload bundle → android/app/build/outputs/bundle/release/
```

---

## Related docs

- Native build: [`sec-night-life/docs/CAPACITOR_BUILD.md`](../sec-night-life/docs/CAPACITOR_BUILD.md)
- Android signing: [`sec-night-life/docs/ANDROID_RELEASE_SIGNING.md`](../sec-night-life/docs/ANDROID_RELEASE_SIGNING.md)
- Launch checklist: [`sec-night-life/docs/LAUNCH_CHECKLIST.md`](../sec-night-life/docs/LAUNCH_CHECKLIST.md)
- Founder handoff: [`sec-night-life/docs/FOUNDER_LAUNCH_HANDOFF.md`](../sec-night-life/docs/FOUNDER_LAUNCH_HANDOFF.md)
