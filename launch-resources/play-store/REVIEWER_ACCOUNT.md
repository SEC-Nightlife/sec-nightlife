# Play Console — Reviewer / App Access Account

Google reviewers need credentials for restricted features (bookings, messaging, wallet).

## Create the account (Founder)

1. Open https://secnightlife.com on a browser
2. Register a dedicated account (recommended):
   - Email: `play-review@secnightlife.com` (or another inbox you control)
   - Full name: `Play Reviewer`
   - Username: `playreviewer`
   - Intent: **Party-Goer**
3. Complete email verification / OTP
4. Finish profile setup (18+ DOB, city e.g. Johannesburg)
5. Confirm you can:
   - Open Home feed
   - Open Messages
   - Open a venue / event detail
   - Reach Settings → Delete account (do **not** delete the reviewer account)

Store email + password in the company password manager.

## Paste into Play Console → App access

Select: **All or some functionality in my app is restricted**

Then paste (replace bracketed values):

```
Reviewer access for SEC Nightlife

1. Open the app. Guest browsing works without login after the 18+ age gate (Home feed).
2. Core features (bookings, messaging, wallet, hosting, venue tools) require an account.
3. Sign in with:

Email: [PLAY_REVIEW_EMAIL]
Password: [PLAY_REVIEW_PASSWORD]
Role: Party-goer (USER)

4. If email OTP is requested at login, contact support@secnightlife.com and we will verify the reviewer session immediately.
5. Suggested checks: Home discovery → open venue/event → Profile → Messages → Settings.

Support: support@secnightlife.com
Help Center: https://secnightlife.com/HelpCenter
Privacy: https://secnightlife.com/PrivacyPolicy
```

## Optional second credential (venue tools)

If you want reviewers to see Business Dashboard:

1. Register a second account as **Business Owner / Venue**
2. Complete minimal venue onboarding on production
3. Add a second credential block in App access with that email/password and note “Venue owner test account”

## Checklist

- [ ] Reviewer party-goer account created and verified on production
- [ ] Password stored securely (not in git)
- [ ] App access form filled in Play Console
- [ ] Optional venue owner test account created
