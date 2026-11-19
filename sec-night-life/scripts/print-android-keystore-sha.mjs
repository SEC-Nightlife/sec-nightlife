#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(root, 'android');
const propsPath = join(androidDir, 'keystore.properties');
const keystorePath = join(androidDir, 'sec-release.keystore');

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
  throw new Error('keytool not found.');
}

function loadProps(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

if (!existsSync(propsPath) || !existsSync(keystorePath)) {
  console.error('Missing keystore. Run: npm run android:keystore');
  process.exit(1);
}

const props = loadProps(propsPath);
const keytool = findKeytool();
const output = execFileSync(
  keytool,
  ['-list', '-v', '-keystore', keystorePath, '-alias', props.keyAlias || 'sec-nightlife', '-storepass', props.storePassword],
  { encoding: 'utf8' },
);

const sha256 = output.match(/SHA256:\s*([0-9A-Fa-f:]+)/)?.[1];
const sha1 = output.match(/SHA1:\s*([0-9A-Fa-f:]+)/)?.[1];
console.log(output);
if (sha256) {
  console.log('\n--- Copy into public/.well-known/assetlinks.json ---');
  console.log(sha256);
}
if (sha1) console.log('SHA-1:', sha1);
