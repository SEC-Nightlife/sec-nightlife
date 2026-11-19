#!/usr/bin/env node
/**
 * Creates android/sec-release.keystore + android/keystore.properties (gitignored).
 * Usage:
 *   npm run android:keystore
 * Env overrides (optional, non-interactive):
 *   ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_PASSWORD
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(root, 'android');
const keystorePath = join(androidDir, 'sec-release.keystore');
const propsPath = join(androidDir, 'keystore.properties');
const alias = 'sec-nightlife';

function findKeytool() {
  const candidates = [
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'),
    'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\keytool.exe',
    'C:\\Program Files\\Java\\jdk-22\\bin\\keytool.exe',
    'keytool',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'keytool' || existsSync(c)) return c;
  }
  throw new Error('keytool not found. Install Android Studio or JDK 17+.');
}

function ask(rl, question, { secret = false } = {}) {
  return new Promise((resolve) => {
    if (secret && rl.stdoutMute !== undefined) {
      // fallback: still echo on some terminals; prefer env vars in CI
    }
    rl.question(question, (answer) => resolve(String(answer || '').trim()));
  });
}

async function main() {
  if (existsSync(keystorePath)) {
    console.error(`Keystore already exists: ${keystorePath}`);
    console.error('Delete it only if you intentionally want to rotate (breaks Play updates if already uploaded).');
    process.exit(1);
  }

  const keytool = findKeytool();
  let storePass = process.env.ANDROID_KEYSTORE_PASSWORD || '';
  let keyPass = process.env.ANDROID_KEY_PASSWORD || '';

  if (!storePass || !keyPass) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Creating Play release keystore for com.secnightlife.app');
    console.log('Back up the passwords in a password manager. Losing them blocks Play updates.\n');
    if (!storePass) {
      const generated = randomBytes(18).toString('base64url');
      const entered = await ask(rl, `Store password [Enter for generated]: `);
      storePass = entered || generated;
      if (!entered) console.log(`Generated store password (save it): ${storePass}`);
    }
    if (!keyPass) {
      const same = await ask(rl, 'Use same password for key? [Y/n]: ');
      if (!same || same.toLowerCase() === 'y') {
        keyPass = storePass;
      } else {
        keyPass = await ask(rl, 'Key password: ');
      }
    }
    rl.close();
  }

  if (storePass.length < 6 || keyPass.length < 6) {
    throw new Error('Passwords must be at least 6 characters.');
  }

  const dname =
    process.env.ANDROID_KEY_DNAME ||
    'CN=SEC Nightlife, OU=Mobile, O=SEC Nightlife, L=Johannesburg, ST=Gauteng, C=ZA';

  execFileSync(
    keytool,
    [
      '-genkeypair',
      '-v',
      '-keystore',
      keystorePath,
      '-alias',
      alias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-storepass',
      storePass,
      '-keypass',
      keyPass,
      '-dname',
      dname,
    ],
    { stdio: 'inherit' },
  );

  writeFileSync(
    propsPath,
    [
      `storePassword=${storePass}`,
      `keyPassword=${keyPass}`,
      `keyAlias=${alias}`,
      `storeFile=sec-release.keystore`,
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );

  console.log(`\nWrote ${keystorePath}`);
  console.log(`Wrote ${propsPath} (gitignored)`);
  console.log('Next: npm run android:keystore:sha   then   npm run android:aab');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
