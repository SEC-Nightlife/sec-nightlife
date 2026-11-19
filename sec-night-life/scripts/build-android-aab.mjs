#!/usr/bin/env node
/**
 * Builds a signed release AAB for Play Console upload.
 * Requires android/keystore.properties + android/sec-release.keystore
 *
 * Env:
 *   SKIP_MOBILE_BUILD=1  — skip vite/cap sync (use when assets already synced)
 *   ANDROID_HOME / ANDROID_SDK_ROOT — used to write local.properties if missing
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(root, 'android');
const propsPath = join(androidDir, 'keystore.properties');
const keystorePath = join(androidDir, 'sec-release.keystore');
const localPropsPath = join(androidDir, 'local.properties');
const aabPath = join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const isWin = process.platform === 'win32';
const gradlew = join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');

function ensureLocalProperties() {
  if (existsSync(localPropsPath)) return;
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (isWin ? join(homedir(), 'AppData', 'Local', 'Android', 'Sdk') : join(homedir(), 'Android', 'Sdk'));
  if (!existsSync(sdk)) {
    throw new Error(
      `Android SDK not found at ${sdk}. Set ANDROID_HOME or create android/local.properties with sdk.dir=...`,
    );
  }
  const escaped = sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  writeFileSync(localPropsPath, `## gitignored — local Android SDK\nsdk.dir=${escaped}\n`, 'utf8');
  console.log(`Wrote ${localPropsPath}`);
}

/** Capacitor Android plugins require JDK 21; prefer JAVA_HOME, else Android Studio JBR. */
function resolveJavaHome() {
  const candidates = [
    process.env.JAVA_HOME,
    isWin ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : null,
    isWin ? join(homedir(), 'AppData', 'Local', 'Programs', 'Android', 'Android Studio', 'jbr') : null,
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  ].filter(Boolean);
  for (const dir of candidates) {
    const javaBin = join(dir, 'bin', isWin ? 'java.exe' : 'java');
    if (existsSync(javaBin)) return dir;
  }
  return process.env.JAVA_HOME || undefined;
}

if (!existsSync(propsPath) || !existsSync(keystorePath)) {
  console.error('Missing release keystore. Run: npm run android:keystore');
  process.exit(1);
}

if (!existsSync(gradlew)) {
  console.error('android/gradlew not found.');
  process.exit(1);
}

ensureLocalProperties();

if (process.env.SKIP_MOBILE_BUILD === '1') {
  console.log('1/3 skip vite/cap sync (SKIP_MOBILE_BUILD=1)');
} else {
  // Android AAB does not need iOS icon sync (which can fail on Windows file locks).
  console.log('1/3 vite build + cap sync android…');
  const env = {
    ...process.env,
    FORCE_PRODUCTION_ENV_CHECK: '1',
    VITE_API_URL: process.env.VITE_API_URL || 'https://api.secnightlife.com',
    VITE_PUBLIC_APP_URL: process.env.VITE_PUBLIC_APP_URL || 'https://secnightlife.com',
  };
  execSync('node scripts/validate-frontend-env.mjs', { cwd: root, stdio: 'inherit', env });
  execSync('npx vite build', { cwd: root, stdio: 'inherit', env });
  execSync('npx cap sync android', { cwd: root, stdio: 'inherit', env });
}

console.log('2/3 gradle bundleRelease…');
const javaHome = resolveJavaHome();
if (javaHome) {
  console.log(`Using JAVA_HOME=${javaHome}`);
} else {
  console.warn('JAVA_HOME not set and Android Studio JBR not found — Gradle may fail without JDK 21.');
}
// Quote the gradlew path — workspace paths may contain spaces (Windows).
const gradleInvocation = isWin
  ? `"${gradlew}" app:bundleRelease --stacktrace`
  : './gradlew app:bundleRelease --stacktrace';
const gradleUserHome =
  process.env.GRADLE_USER_HOME || join(homedir(), '.gradle');
execSync(gradleInvocation, {
  cwd: androidDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    GRADLE_USER_HOME: gradleUserHome,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
  },
  shell: true,
});

if (!existsSync(aabPath)) {
  console.error('AAB not found at expected path:', aabPath);
  process.exit(1);
}

console.log('\n3/3 Signed AAB ready:');
console.log(aabPath);
console.log('\nUpload to Play Console → Testing → Closed testing → Create new release');
console.log('See: launch-resources/play-store/CLOSED_TESTING.md');
