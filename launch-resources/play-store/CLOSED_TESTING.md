# Play Console — Closed Testing Runbook

Closed testing is **required** before production access for new personal developer accounts.

**Gate:** at least **12 testers opted-in** for the last **14 consecutive days**.  
Invited ≠ opted-in. Internal testing does **not** count.

## Before you start

- [ ] Main store listing complete ([`PLAY_CONSOLE_FILL_IN.md`](PLAY_CONSOLE_FILL_IN.md) Part A)
- [ ] App content declarations complete (Part B)
- [ ] Signed AAB built ([`UPLOAD_AAB.md`](UPLOAD_AAB.md) · [`ANDROID_RELEASE_SIGNING.md`](../../sec-night-life/docs/ANDROID_RELEASE_SIGNING.md))
- [ ] Reviewer account ready ([`REVIEWER_ACCOUNT.md`](REVIEWER_ACCOUNT.md))
- [ ] Feedback log ready ([`tester-feedback-log.md`](tester-feedback-log.md))

## 1. Create closed testing track

1. Play Console → **Test and release** → **Testing** → **Closed testing**
2. Use the default closed track (or create one named `Closed testing`)
3. **Create new release**
4. Upload the signed `.aab` (from `sec-night-life/android/app/build/outputs/bundle/release/`)
5. Release name: `1.0 (6)`
6. Release notes:

```
Initial closed test of SEC Nightlife.
Discover venues and events, book/join tables, messaging, and venue tools.
South Africa launch build.
```

7. Review → **Start rollout to Closed testing**

## 2. Add testers (recruit 15–20)

1. Closed testing → **Testers** tab
2. Create email list: `SEC Closed Testers`
3. Add **15–20** Gmail / Google account emails (buffer above 12)
4. Save
5. Copy the **opt-in link** (looks like `https://play.google.com/apps/testing/com.secnightlife.app`)

### Tester invite message (copy/paste)

```
Hi — please help beta-test SEC Nightlife on Google Play (South Africa nightlife app).

1. Open this link on your Android phone while signed into Google:
   [PASTE OPT-IN LINK]
2. Tap Become a tester / Accept.
3. Install SEC Nightlife from the Play Store link on that page.
4. Stay opted in for at least 14 days (do not leave the test).
5. Try: open app → 18+ gate → browse Home → register/login → open a venue/event → Messages if you can.
6. Send feedback here or email support@secnightlife.com

Thanks — this unlocks our public Play Store launch.
```

## 3. Verify opted-in count

Dashboard / Closed testing should show **opted-in** testers (not just invited).

Target: **12+ opted-in** before you treat day 1 as started. Prefer 15+ in case someone leaves.

## 4. 14-day engagement plan

Ask testers to use the app at least a few times during the two weeks:

| Day | Ask testers to |
|-----|----------------|
| 1–2 | Install, accept 18+ gate, browse Home, register/login |
| 3–5 | Open venues/events, Profile, Friends/Messages |
| 6–10 | Try booking / table join flow if live payments allow; venue owners try Business Dashboard |
| 11–14 | Smoke retest + send final feedback |

Collect feedback in WhatsApp / email / Play **Testing feedback**.

### Feedback log template

| Date | Tester | Device | Feedback | Action taken |
|------|--------|--------|----------|--------------|
| | | | | |

Keep this log — you will summarize it in [`PRODUCTION_ACCESS.md`](PRODUCTION_ACCESS.md).

## 5. During the wait

- Keep the closed release live
- If opted-in count drops below 12, invite replacements immediately
- Upload crash-fix AABs to the same closed track if needed (`versionCode` must increase)

## 6. After 14 consecutive days

1. Confirm Dashboard still shows 12+ opted-in for 14 days
2. Open **Apply for production** on Dashboard
3. Use answers in [`PRODUCTION_ACCESS.md`](PRODUCTION_ACCESS.md)

## Checklist

- [ ] Closed release rolled out with signed AAB
- [ ] 15–20 testers invited
- [ ] 12+ show as **opted-in**
- [ ] Opt-in link shared; installs confirmed
- [ ] Feedback channel active
- [ ] 14 consecutive days completed without dropping below 12
