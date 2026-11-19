# Upload signed AAB to Closed testing

## Bundle location (local, gitignored)

After `npm run android:aab` (or the Gradle `bundleRelease` used for this emergency build):

```
sec-night-life/android/app/build/outputs/bundle/release/app-release.aab
```

- **Package:** `com.secnightlife.app`
- **versionName:** `1.0.4`
- **versionCode:** `11`
- **Signed with:** `android/sec-release.keystore` (alias `sec-nightlife`)
- **Release minify:** on (R8 mapping is embedded in the AAB)
- **Native symbols:** upload `native-debug-symbols.zip` next to the AAB (AndroidX `.so` ships pre-stripped, so Play needs this zip)

Bundle folder:

```
sec-night-life/android/app/build/outputs/bundle/release/
  app-release.aab
  native-debug-symbols.zip
```

## Play Console steps

1. Open [Play Console](https://play.google.com/console) → **SEC Nightlife**
2. **Test and release → Testing → Closed testing → Create new release**
3. Upload the **new** `app-release.aab` (must be version code **11**)
4. Upload **native debug symbols**: App bundle explorer for version code **11** → upload `native-debug-symbols.zip`
5. Release name: `1.0.4 (11)`
6. Release notes:

```
Update: signup/legal docs and register policy fixes (closed test 1.0.4).
```

7. Confirm both warnings are gone (or only informational), then Save → send for review / start rollout to Closed testing – Alpha
8. When **Available to selected testers**, ask testers to **Update** (not just open the old install)

## After upload — tester message

```
SEC Nightlife update is live — please UPDATE then open once.

1. Open Play Store → My apps / updates, or:
https://play.google.com/store/apps/details?id=com.secnightlife.app

2. Update SEC Nightlife — confirm it shows 1.0.4
3. Force-stop the old app if needed (App info → Force stop), then open once

You should see a BLACK SEC splash briefly, then age gate / Home.
NOT a white Capacitor logo, and NOT a permanent hang.

Reply ✅ if it opens correctly.
Still do not explore features until I send test instructions.
```

## Verification checklist (one Android 12+ device)

1. Uninstall or Update to **1.0.4 (11)** from the closed-test Play link
2. Cold start
3. Expect: black SEC splash briefly → age gate/Home
4. If still fails: capture `adb logcat` filtered for `AndroidRuntime|SplashScreen|Capacitor|FATAL` and share

## Rebuild later

```bash
cd sec-night-life
npm run android:aab
```

Each new Play upload needs a **higher versionCode** in `android/app/build.gradle`.

## Keystore backup (critical)

Copy these to a password manager / offline backup **before** uploading to Play:

- `android/sec-release.keystore`
- `android/keystore.properties` (contains passwords)

Losing them means you cannot update the app on Play Store.
