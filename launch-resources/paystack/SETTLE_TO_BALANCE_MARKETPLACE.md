# Paystack: Settled to Balance (marketplace venue Transfers)

**Business:** Sec Nightlife · Paystack ID **1806436**  
**Goal:** Customer charges settle into **Paystack Balance (Available)** so the SEC app can **automatically Transfer** venue/host shares. SEC’s platform fee stays in Available (withdraw to Standard Bank when you choose). Money must **not** auto-payout the full net to Standard Bank.

**Do not switch payment gateways** until this path is proven impossible. The app already auto-Transfers from Available when funded.

**Never share Paystack login/password with developers or AI tools.** Founder/ops click the dashboard; engineers guide from screenshots.

---

## Status (5 Aug 2026)

| Check | Result |
|-------|--------|
| Manual Payouts (Chika) | Enabled — payouts process into Paystack Balance |
| Preferences → Payout schedule | **Settled to Balance** (confirmed) |
| Transfer Approval URLs (live/test) | Unchecked — leave off (app has no OTP/`finalize_transfer`) |
| Confirm transfers before sending (OTP) | Keep **off** |
| Live public key on API | `pk_live_…` served from `https://api.secnightlife.com` |
| Cron `GET /api/cron/retry-payouts` | Authorized; runs daily 07:00 UTC; manual run 5 Aug retried 22 PENDING |
| Available balance | **Topup R50** credited (5 Aug evening) |
| Transfers smoke | Cron retry initiated **3** Veldt & Vine Transfers (R38.25 + R8.50 + R8.50) → ledger **PROCESSING** |
| Paystack status | All three stuck on **`otp`** — dashboard “Confirm transfers before sending” is blocking auto-payouts |
| Sec Wallet Received | After OTP is completed → `transfer.success` → **TRANSFERRED** / Received |

**Founder action (required):** Open [Transfers](https://dashboard.paystack.com/#/transfers) (Live). Complete the **OTP / confirm** for the three pending sends (R38.25, R8.50, R8.50 to Veldt & Vine). Then turn **off** Preferences → **Confirm transfers before sending** so future marketplace Transfers do not need OTP (the app cannot enter OTP).

---

## Money flow (intended)

1. Customer pays Sec Nightlife (live charge).
2. Paystack takes its processing fee.
3. Net settles into **Transfers → Balance → Available** (Payout schedule = **Settled to Balance**).
4. App Transfers API sends venue/host share (~85% or ~96% on tickets) to their Sec Wallet recipient.
5. SEC platform fee remains in Available; withdraw to Standard Bank later if needed.

If **Payouts** shows **Paid → Sec Nightlife ~R8.51** and **Available = R0**, settlement is still going to the **business bank**, not Available. Venue Sec Wallet stays **Pending**.

---

## Step 1 — Confirm Manual Payouts (Preferences, not Accounts)

Official check ([Paystack Manual payouts](https://support.paystack.com/en/articles/2131074)):

1. Open **[Settings → Preferences](https://dashboard.paystack.com/#/settings/preferences)** while logged into **Sec Nightlife (1806436)**, **Live**.
2. Find **Tax Invoices, Payouts & Balances** → **Payout schedule**.
3. It must say **Settled to Balance** (Manual).

**Wrong page:** Settings → Accounts → Payouts (Standard Bank ENABLED) only shows the withdraw/settlement bank. That does **not** prove Settled to Balance.

Screenshot Preferences (Payout schedule line) + Transfers → Balance + Payouts list.

If schedule is still **Settled two days after** (or similar auto bank schedule), Manual Payouts was not applied — escalate (Step 2).

---

## Step 2 — Escalation email (copy/paste)

Send to the support thread (Ijeoma / Favour). Attach screenshots.

```
Subject: Manual Payouts not Settled to Balance — 1806436 still auto-pays Standard Bank

Hi Ijeoma / Favour,

On 30 Jul you confirmed Manual Payouts for Sec Nightlife (1806436). Customer charges are still settling as Payouts → Paid to Sec Nightlife / Standard Bank (ZAR 8.51 on 25 Jul and again on 1 Aug). Transfers → Balance → Available remains R0, so our Transfers API cannot pay venue/host shares.

Please confirm on 1806436:

1. Settings → Preferences → Payout schedule is Settled to Balance (not automatic bank payout).
2. New live charges credit Paystack Balance / Available for Transfers (marketplace: we Transfer ~85%/96% to venue recipients; SEC keeps the platform fee in balance).
3. Stop auto-payout of full settlement to Standard Bank for this account.

Screenshots of Preferences + Payouts + Balance attached / available on request.

Kind regards,
Sihle — Sec Nightlife / Menzi Simelane
```

If Preferences already shows Settled to Balance but bank payouts continue, ask them to **re-apply the schedule switch** (SA is backend-only).

---

## Step 3 — Topup smoke test (proves Transfers while waiting on first Balance settlement)

Manual Payouts is on; old Standard Bank **Paid** rows do **not** move back into Available. Until a **new** live charge settles into Available (or you Topup), venue shares stay Pending.

1. Open **[Transfers → Balance](https://dashboard.paystack.com/#/transfers/balance)** (Live, Sec Nightlife).
2. **Topup** at least **R20–R50** (SA EFT; ~1% top-up fee). Wait until **Available** shows the credit.
3. Trigger retry: wait for daily cron (07:00 UTC) **or** eng runs `GET https://api.secnightlife.com/api/cron/retry-payouts` with `CRON_SECRET`.
4. Confirm:
   - Paystack → **Transfers** shows an outbound send (~R8.50 to Veldt & Vine recipient).
   - Business Dashboard → Sec Wallet → that line is **Received**.
5. Optional second check: one new small live entrance — net should land in **Available** (not a new full-net **Payouts → Paid** to Standard Bank); SEC fee remains in Available after the venue Transfer.

---

## Success criteria (after Settled to Balance works)

1. Preferences stays **Settled to Balance**.
2. Available increases after a new live sale (or Topup), not only bank **Paid** payouts.
3. Paystack **Transfers** shows ~venue share to the venue recipient.
4. Sec Wallet line → **Received**.
5. SEC fee remains in Available (optional later withdraw to Standard Bank).

---

## Weekly batch payouts (from October 2026)

The app no longer sends one Transfer per sale. Each sale is recorded as a PENDING payout, and every **Monday 07:00 UTC (09:00 SAST)** the cron `GET /api/cron/weekly-payouts` sends **one Transfer per venue/host** whose balance is **≥ R50** (reference `secbatch-<id>`). Smaller balances roll over to the next Monday. Guests also pay a flat **R5 SEC service fee** per checkout, which stays in Available with SEC’s platform fee.

No special Paystack product is needed — batching is done by the app using the normal Transfers API. **Do not** use Paystack Bulk Transfers or the dashboard bulk upload for these payouts.

### Paystack checklist (founder clicks; never share login)

| Setting | Required value |
|---------|----------------|
| Settings → Preferences → Payout schedule | **Settled to Balance** (keep) |
| Settings → Preferences → Confirm transfers before sending (OTP) | **Off** — the app cannot enter OTPs |
| Transfer Approval URL (live/test) | **Unchecked** |
| IP whitelisting for Transfers | **Off** (Vercel has no fixed IPs) |
| Settings → API Keys & Webhooks → Live webhook URL | `https://api.secnightlife.com/api/webhooks/paystack` (must keep receiving `transfer.success`, `transfer.failed`, `transfer.reversed`) |
| Transfers → Balance → Available | Enough on Monday morning to cover the week’s venue/host shares |

**Balance tip:** weekend sales settle into Available after 1–2 business days, so some Saturday/Sunday money may not be Available by 09:00 Monday. If a batch fails for low balance, the rows stay Pending and the daily retry (10:30 UTC) sends it once funds settle. Keeping a small float (e.g. R200–R500 via Topup) avoids delays.

**Manual run (eng):** `GET https://api.secnightlife.com/api/cron/weekly-payouts` with `Authorization: Bearer <CRON_SECRET>`.

---

## Fallback (only if Balance Transfers still impossible)

Stay on Paystack; plan a later engineering change to **Transaction Splits + Subaccounts** (settle venue share at charge time). That is a separate project — do not migrate to another gateway first.

Marketing emails about the “new Dashboard” (Transfers UI, Recurring, Audit Logs) are unrelated to settlement schedule.
