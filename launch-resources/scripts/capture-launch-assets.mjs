/**
 * Interactive launch asset capture — production, real accounts, manual login.
 *
 * Usage (from sec-night-life/):
 *   npm run launch:capture
 *   npm run launch:capture:business
 *   npm run launch:capture:party
 *
 * Env:
 *   BASE_URL  — default https://secnightlife.com
 */
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  PRODUCTION_URL,
  VIEWPORT,
  DEVICE_SCALE_FACTOR,
  BUSINESS_SCREENSHOTS,
  PARTY_AUTH_SCREENSHOTS,
} from './capture-routes.mjs';
import {
  waitForManualLogin,
  gotoAuthenticated,
  screenshot,
  logout,
  ensureBusinessMode,
  ensurePartyGoerMode,
  launchVisibleBrowser,
} from './capture-helpers.mjs';
import { syncStoreScreenshots } from './generate-store-assets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '../../sec-night-life/package.json'));
const { chromium } = require('playwright');

const KIT_ROOT = join(__dirname, '..');
const BASE_URL = (process.env.BASE_URL || PRODUCTION_URL).replace(/\/+$/, '');
const SHOTS_PARTY = join(KIT_ROOT, 'screenshots/mobile/party-goer');
const SHOTS_BUSINESS = join(KIT_ROOT, 'screenshots/mobile/business-owner');
const CONTINUE_BUSINESS = join(__dirname, '.continue-business');
const CONTINUE_PARTY = join(__dirname, '.continue-party');

async function captureScreenshots(page, routes, outputDir, { business = false } = {}) {
  if (business) await ensureBusinessMode(page, BASE_URL);
  else await ensurePartyGoerMode(page, BASE_URL);

  for (const route of routes) {
    try {
      await gotoAuthenticated(page, BASE_URL, route.path, route);
      if (route.beforeScreenshot) await route.beforeScreenshot(page);
      await screenshot(page, KIT_ROOT, join(outputDir, route.file), { requireAuth: true });
    } catch (err) {
      console.warn(`  ⚠ Skipping ${route.file || route.path}: ${err?.message || err}`);
      try {
        await page.goto(`${BASE_URL}${route.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);
        await page.locator('body').screenshot({
          path: join(outputDir, route.file),
          timeout: 60000,
          animations: 'disabled',
        });
        console.log(`  ✓ (fallback) \\screenshots\\...\\${route.file}`);
      } catch (fallbackErr) {
        console.warn(`  ✗ Failed ${route.file}: ${fallbackErr?.message || fallbackErr}`);
      }
    }
  }
}

async function main() {
  mkdirSync(SHOTS_PARTY, { recursive: true });
  mkdirSync(SHOTS_BUSINESS, { recursive: true });

  const partyOnly = process.argv.includes('--party-only');
  const businessOnly = process.argv.includes('--business-only');

  console.log(`\nSEC Launch Capture — ${BASE_URL}`);
  console.log(`Mobile viewport: ${VIEWPORT.width}×${VIEWPORT.height} @${DEVICE_SCALE_FACTOR}x\n`);

  const browser = await launchVisibleBrowser(chromium, { slowMo: 50 });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  try {
    if (!partyOnly) {
      await waitForManualLogin(page, BASE_URL, {
        roleIntent: 'VENUE',
        continueFile: CONTINUE_BUSINESS,
        instructions: [
          'PHASE 1 — BUSINESS OWNER',
          '1. Sign in with your Business Owner account in the browser.',
          '2. Complete the email OTP step if prompted.',
          '3. You do NOT need the nav bar — the script opens Business Dashboard for you.',
        ].join('\n'),
      });

      console.log('\n── Business Owner screenshots ──');
      await captureScreenshots(page, BUSINESS_SCREENSHOTS, SHOTS_BUSINESS, { business: true });

      if (businessOnly) {
        await syncStoreScreenshots(KIT_ROOT);
        console.log('\n✓ Business screenshots complete.\n');
        return;
      }

      console.log('\nLogging out for Party-Goer phase...');
      await logout(page, BASE_URL);
    }

    await waitForManualLogin(page, BASE_URL, {
      roleIntent: 'PARTY_GOER',
      continueFile: CONTINUE_PARTY,
      instructions: [
        partyOnly ? 'PARTY-GOER SCREENSHOTS' : 'PHASE 2 — PARTY-GOER',
        '1. Sign in with your Party-Goer account in the browser.',
        '2. Stay in Party Goer mode (not Business).',
        '3. Wait until you land on the Home feed (/Home).',
      ].join('\n'),
    });

    console.log('\n── Party-Goer screenshots ──');
    await captureScreenshots(page, PARTY_AUTH_SCREENSHOTS, SHOTS_PARTY);

    await syncStoreScreenshots(KIT_ROOT);
    console.log('\n✓ Launch capture complete.');
    console.log('  Mobile screenshots:', join(KIT_ROOT, 'screenshots/mobile'));
    console.log('  Store exports:', join(KIT_ROOT, 'app-store/screenshots'), '&', join(KIT_ROOT, 'play-store/screenshots'));
    console.log('  Rebuild zip: Compress-Archive -Path launch-resources -DestinationPath sec-launch-resources.zip -Force\n');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
