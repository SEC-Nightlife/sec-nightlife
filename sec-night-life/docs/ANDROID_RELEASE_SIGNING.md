# Android release signing + AAB (Play Store)

- `versionName`: `1.0.2` · `versionCode`: `8` ([`android/app/build.gradle`](../android/app/build.gradle))
- Splash: Android 12 `postSplashScreenTheme` + SEC splash assets (not default Capacitor logo)
- Vite `base: './'` for reliable Capacitor asset loading


Losing the release keystore or passwords means you **cannot update** the Play Store app. Back them up in a password manager offline.

## One-time: create keystore

From `sec-night-life/`:

```bash
npm run android:keystore
```

This writes (gitignored):

- `android/sec-release.keystore`
- `android/keystore.properties`

Or manually:

```bash
"/c/Program Files/Android/Android Studio/jbr/bin/keytool.exe" -genkeypair -v \
  -keystore android/sec-release.keystore \
  -alias sec-nightlife \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass 'YOUR_STORE_PASS' -keypass 'YOUR_KEY_PASS' \
  -dname "CN=SEC Nightlife, OU=Mobile, O=SEC Nightlife, L=Johannesburg, ST=Gauteng, C=ZA"
```

Then create `android/keystore.properties`:

```properties
storePassword=YOUR_STORE_PASS
keyPassword=YOUR_KEY_PASS
keyAlias=sec-nightlife
storeFile=sec-release.keystore
```

## Build signed AAB

```bash
npm run android:aab
```

Output:

`android/app/build/outputs/bundle/release/app-release.aab`

Upload steps: [`launch-resources/play-store/UPLOAD_AAB.md`](../../launch-resources/play-store/UPLOAD_AAB.md)  
Closed testing: [`launch-resources/play-store/CLOSED_TESTING.md`](../../launch-resources/play-store/CLOSED_TESTING.md)

If R8 fails on Capacitor splash classes, `android/app/proguard-rules.pro` already keeps/dontwarns `com.capacitorjs.**`.

## SHA-256 for App Links

```bash
npm run android:keystore:sha
```

Copy the **SHA-256** into `public/.well-known/assetlinks.json` (replace `FOUNDER_ANDROID_SHA256_FINGERPRINT`), then redeploy the frontend.

## Android Studio alternative

1. `npm run build:mobile`
2. `npm run cap:android`
3. Build → Generate Signed Bundle / APK → Android App Bundle → release keystore above
