import { readFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { VIEWPORT } from './capture-routes.mjs';

/** Launch a visible browser — prefers installed Google Chrome on Windows. */
export async function launchVisibleBrowser(chromium, { slowMo = 50 } = {}) {
  const base = {
    headless: false,
    slowMo,
    args: ['--start-maximized', '--disable-backgrounding-occluded-windows'],
  };
  for (const channel of ['msedge', 'chrome', null]) {
    try {
      const opts = channel ? { ...base, channel } : base;
      const browser = await chromium.launch(opts);
      console.log(`Using browser: ${channel === 'chrome' ? 'Google Chrome' : channel === 'msedge' ? 'Microsoft Edge' : 'Playwright Chromium'}`);
      return browser;
    } catch (err) {
      const label = channel || 'Playwright Chromium';
      console.warn(`Could not launch ${label}: ${String(err?.message || err).split('\n')[0]}`);
    }
  }
  throw new Error(
    'No browser could be opened. Install Google Chrome, or run: npx playwright install chromium',
  );
}

export async function waitForEnter(prompt = 'Press ENTER when ready... ', continueFile = null) {
  if (continueFile) {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
      if (existsSync(continueFile)) {
        try {
          unlinkSync(continueFile);
        } catch {
          // ignore
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for continue file: ${continueFile}`);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

export async function waitForApp(page, timeout = 20000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

export async function getAuthStatus(page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
    const path = window.location.pathname.toLowerCase();
    const onLogin = path.includes('/login');
    const signInHeading = Array.from(document.querySelectorAll('h1')).some((el) =>
      /sign in/i.test(el.textContent || '')
    );
    const nav = document.querySelector('nav.lg\\:hidden');
    const navLabels = nav
      ? Array.from(nav.querySelectorAll('span')).map((s) => s.textContent?.trim()).filter(Boolean)
      : [];
    const navInteractiveCount = nav
      ? nav.querySelectorAll('a[href], button[type="button"]').length
      : 0;
    const onBusinessRoute = /business|venueanalytics|businessbookings|businessmenu/i.test(path);
    const hasAppShell =
      navInteractiveCount >= 3 ||
      navLabels.includes('Home') ||
      navLabels.includes('Host') ||
      navLabels.includes('Profile') ||
      navLabels.includes('Messages') ||
      navLabels.includes('Dashboard') ||
      navLabels.includes('Events') ||
      onBusinessRoute;

    if (signInHeading || onLogin) return { ok: false, reason: 'on_login_page' };
    if (!token) return { ok: false, reason: 'no_token' };

    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) return { ok: false, reason: `me_${res.status}` };
      // Valid session — allow capture even if bottom nav labels are icon-only
      if (hasAppShell) return { ok: true };
      return { ok: true, reason: 'authenticated_no_nav' };
    } catch {
      return { ok: false, reason: 'network' };
    }
  });
}

export async function waitForAuthenticatedShell(page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const signIn = Array.from(document.querySelectorAll('h1')).some((el) =>
        /sign in/i.test(el.textContent || '')
      );
      if (signIn) return false;
      const token = localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
      if (!token) return false;
      const nav = document.querySelector('nav.lg\\:hidden');
      if (nav && nav.querySelectorAll('a[href], button[type="button"]').length >= 3) return true;
      const path = window.location.pathname.toLowerCase();
      return /business|home|profile|hostdashboard/i.test(path);
    },
    { timeout }
  );
  await page.waitForTimeout(1200);
}

async function safeGetAuthStatus(page) {
  try {
    return await getAuthStatus(page);
  } catch (err) {
    if (/destroyed|navigation|context/i.test(String(err?.message || err))) {
      return { ok: false, reason: 'navigating' };
    }
    throw err;
  }
}

/** Poll until access token is stored, /api/auth/me succeeds, and we are off the Login screen. */
export async function waitUntilAuthenticated(page, baseUrl, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let lastReason = 'waiting';
  while (Date.now() < deadline) {
    const status = await safeGetAuthStatus(page);
    if (status.ok) {
      await waitForApp(page);
      return true;
    }
    lastReason = status.reason;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Login session not detected (${lastReason}). Sign in as Party-Goer, wait until Home loads, then try again.`
  );
}

export async function assertAuthenticatedScreen(page, label = '') {
  await waitForAuthenticatedShell(page, 15000).catch(() => {});
  const status = await getAuthStatus(page);
  if (!status.ok) {
    const suffix = label ? ` — ${label}` : '';
    throw new Error(`Screenshot blocked${suffix}: page is not authenticated (${status.reason}).`);
  }
}

export async function goto(page, baseUrl, path, timeout = 180000) {
  const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await waitForApp(page);
}

export async function screenshot(page, kitRoot, filePath, { requireAuth = false } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  await waitForApp(page);
  if (requireAuth) {
    await assertAuthenticatedScreen(page, filePath.replace(kitRoot, ''));
  }
  await page.locator('body').screenshot({
    path: filePath,
    timeout: 90000,
    animations: 'disabled',
  });
  console.log('  ✓', filePath.replace(kitRoot, ''));
}

export async function captureBrandSplash(page, kitRoot) {
  const logoB64 = readFileSync(join(kitRoot, 'brand/logos/sec-logo.png')).toString('base64');
  await page.setViewportSize(VIEWPORT);
  await page.setContent(`<!DOCTYPE html>
<html class="dark"><head>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 390px; height: 844px; background: #000;
    font-family: Inter, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    color: #F5F5F5;
  }
  .wrap { text-align: center; max-width: 340px; padding: 40px 24px; }
  .logo { width: 128px; height: 128px; margin: 0 auto 40px; display: block; object-fit: contain; }
  h1 { font-size: 38px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.02em; }
  .tagline { color: #6B6B6B; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 600; margin-bottom: 24px; }
  .desc { color: #B8B8B8; font-size: 15px; line-height: 1.65; margin-bottom: 40px; }
  .btn {
    width: 100%; padding: 14px; border: none; border-radius: 6px;
    background: linear-gradient(135deg, #A8A8A8 0%, #D8D8D8 40%, #A0A0A0 70%, #C8C8C8 100%);
    color: #0B0B0F; font-size: 15px; font-weight: 600;
  }
  .members { margin-top: 14px; color: #6B6B6B; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
</style></head><body>
<div class="wrap">
  <img class="logo" src="data:image/png;base64,${logoB64}" alt="SEC" />
  <h1>SEC</h1>
  <p class="tagline">Your Night. Simplified.</p>
  <p class="desc">Discover events, book and join tables, and connect with the nightlife community.</p>
  <button class="btn" type="button">Enter</button>
  <p class="members">Members only</p>
</div></body></html>`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
}

export async function logout(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await waitForApp(page);
}

/** Poll until business dashboard shell is visible. */
export async function waitUntilBusinessReady(page, baseUrl, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const path = page.url();
    if (/BusinessDashboard|VenueAnalytics|BusinessMenu/i.test(path)) {
      await waitForApp(page);
      return true;
    }
    const status = await safeGetAuthStatus(page);
    if (status.ok) {
      await page.evaluate(() => localStorage.setItem('sec_active_mode', 'business'));
      try {
        await goto(page, baseUrl, '/BusinessDashboard', 90000);
        return true;
      } catch {
        // retry loop
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Business session not detected. Sign in as Business Owner and open Business Dashboard.');
}

async function waitForRoleLoginComplete(page, baseUrl, continueFile, roleIntent) {
  const isBusiness = roleIntent === 'VENUE';
  const autoDetect = waitUntilAuthenticated(page, baseUrl, 60 * 60 * 1000)
    .then(async () => {
      console.log('  ✓ Login detected — preparing session…');
      if (isBusiness) {
        await page.evaluate(() => localStorage.setItem('sec_active_mode', 'business'));
        await goto(page, baseUrl, '/BusinessDashboard');
      }
      console.log('  ✓ Ready — starting capture.');
    });

  const manualSignals = [];
  if (continueFile) manualSignals.push(waitForEnter('', continueFile));
  if (process.stdin.isTTY) {
    manualSignals.push(
      waitForEnter(
        isBusiness
          ? 'Press ENTER when you have finished signing in (any page is fine)... '
          : 'Press ENTER when you are logged in on Home (/Home)... ',
        null,
      ),
    );
  }

  const manual = manualSignals.length
    ? Promise.race(manualSignals).then(async () => {
        console.log('  Continue signal received — verifying session…');
        await waitUntilAuthenticated(page, baseUrl, 180000);
        if (isBusiness) {
          await page.evaluate(() => localStorage.setItem('sec_active_mode', 'business'));
          await goto(page, baseUrl, '/BusinessDashboard');
        }
      })
    : null;

  await Promise.race([autoDetect, ...(manual ? [manual] : [])]);
  await waitForApp(page);
}

export async function waitForManualLogin(page, baseUrl, { roleIntent, instructions, continueFile = null }) {
  const returnPath = roleIntent === 'VENUE' ? '/BusinessDashboard' : '/Home';
  const loginUrl = `${baseUrl}/Login?role=${roleIntent}&returnUrl=${encodeURIComponent(returnPath)}`;

  console.log('\n' + '='.repeat(64));
  console.log(instructions);
  console.log(`\nOpening login page in the browser window…`);
  console.log(`URL: ${loginUrl}`);
  const readyHint =
    roleIntent === 'VENUE'
      ? 'After sign-in, the script opens Business Dashboard automatically.'
      : 'After sign-in, recording continues automatically.';
  console.log(readyHint);
  if (roleIntent === 'VENUE') {
    console.log(`Direct link (optional): ${baseUrl}/BusinessDashboard`);
  }
  if (continueFile) {
    console.log(`\nWhen ready, press ENTER in this terminal OR create file:\n  ${continueFile}`);
  }
  console.log('='.repeat(64) + '\n');

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      sessionStorage.removeItem('access_token');
      sessionStorage.removeItem('refresh_token');
    } catch {
      // ignore if storage blocked on this origin
    }
  });

  if (!continueFile && !process.stdin.isTTY) {
    await waitUntilAuthenticated(page, baseUrl, 60 * 60 * 1000);
    if (roleIntent === 'VENUE') {
      await page.evaluate(() => localStorage.setItem('sec_active_mode', 'business'));
      await goto(page, baseUrl, '/BusinessDashboard');
    }
    return;
  }

  await waitForRoleLoginComplete(page, baseUrl, continueFile, roleIntent);
}

export async function ensureBusinessMode(page, baseUrl) {
  await page.evaluate(() => localStorage.setItem('sec_active_mode', 'business'));
  const onBusiness = /BusinessDashboard|VenueAnalytics|BusinessMenu|BusinessBookings/i.test(page.url());
  if (!onBusiness) {
    await goto(page, baseUrl, '/BusinessDashboard');
  }
  await waitForApp(page);
}

export async function ensurePartyGoerMode(page, baseUrl) {
  await waitUntilAuthenticated(page, baseUrl, 120000);
  await page.evaluate(() => localStorage.setItem('sec_active_mode', 'partygoer'));
  try {
    await goto(page, baseUrl, '/Home');
  } catch (err) {
    console.warn(`  ⚠ Home navigation slow/failed, continuing: ${err?.message || err}`);
  }
  await waitUntilAuthenticated(page, baseUrl, 60000).catch(() => {});
}

export async function gotoAuthenticated(page, baseUrl, path, route = {}) {
  await goto(page, baseUrl, path);
  await waitUntilAuthenticated(page, baseUrl, 90000);
  await waitForAuthenticatedShell(page, 45000).catch((err) => {
    console.warn(`  ⚠ Shell wait soft-fail for ${route.file || path}: ${err?.message || err}`);
  });
  if (route.waitForSelector) {
    await page.waitForSelector(route.waitForSelector, { timeout: 45000 }).catch(() => {
      console.warn(`  ⚠ Selector not found for ${route.file || path}: ${route.waitForSelector}`);
    });
  }
  await page.waitForTimeout(800);
  const status = await getAuthStatus(page).catch(() => ({ ok: false }));
  if (!status.ok) {
    console.warn(`  ⚠ Auth soft soft for ${route.file || path}: ${status.reason || 'unknown'}`);
  }
}

export async function resolveEventDetailsPath(page) {
  try {
    const eventId = await page.evaluate(async () => {
      const token = localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
      if (!token) return null;
      const endpoints = ['/api/events?limit=10', '/api/home-feed', '/api/events'];
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) continue;
          const data = await res.json();
          const list = Array.isArray(data)
            ? data
            : data?.events ?? data?.upcoming ?? data?.items ?? data?.featured ?? [];
          if (Array.isArray(list) && list[0]?.id) return list[0].id;
        } catch {
          // try next endpoint
        }
      }
      return null;
    });
    if (eventId) return `/EventDetails?id=${eventId}`;
  } catch {
    // fall through
  }
  return '/Events';
}

export async function resolveVenueProfilePath(page) {
  try {
    const venueId = await page.evaluate(async () => {
      const token = localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
      if (!token) return null;
      const res = await fetch('/api/venues/mine', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data?.venues ?? [];
      const id = list[0]?.id ?? list[0]?.venue?.id ?? null;
      return id;
    });
    if (venueId) return `/VenueProfile?id=${venueId}`;
  } catch {
    // fall through
  }
  return '/VenueProfile';
}

function hasFfmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function finalizeVideo(webmPath, desiredPath, kitRoot) {
  const webmOut = desiredPath.endsWith('.webm') ? desiredPath : desiredPath.replace(/\.mp4$/i, '.webm');
  if (hasFfmpeg() && desiredPath.endsWith('.mp4')) {
    execSync(
      `ffmpeg -y -i "${webmPath}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${desiredPath}"`,
      { stdio: 'ignore' }
    );
    unlinkSync(webmPath);
    console.log('  ✓', desiredPath.replace(kitRoot, ''));
    return desiredPath;
  }
  if (webmPath !== webmOut) renameSync(webmPath, webmOut);
  console.log('  ✓', webmOut.replace(kitRoot, ''));
  return webmOut;
}

export async function recordWithPage(page, kitRoot, outputPath, steps) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const context = page.context();
  await context.tracing?.stop?.().catch(() => {});
  const browser = context.browser();
  const videoDir = dirname(outputPath);
  await context.close();

  const recordContext = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: 'dark',
    storageState: await browser.contexts()[0]?.storageState?.().catch(() => undefined),
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });

  const recordPage = await recordContext.newPage();
  try {
    for (const step of steps) {
      await step(recordPage);
    }
    await recordPage.waitForTimeout(1500);
  } finally {
    const video = recordPage.video();
    await recordContext.close();
    if (video) {
      const webmPath = await video.path();
      finalizeVideo(webmPath, outputPath, kitRoot);
    }
  }
}

/** Record using the same logged-in page (no context swap). */
export async function recordOnSamePage(page, kitRoot, outputPath, runSteps) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const context = page.context();
  const browser = context.browser();
  const storageState = await context.storageState();

  const recordContext = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: 'dark',
    storageState,
    recordVideo: { dir: dirname(outputPath), size: VIEWPORT },
  });
  const recordPage = await recordContext.newPage();
  try {
    await runSteps(recordPage);
    await recordPage.waitForTimeout(1500);
  } finally {
    const video = recordPage.video();
    await recordContext.close();
    if (video) {
      const webmPath = await video.path();
      finalizeVideo(webmPath, outputPath, kitRoot);
    }
  }
}
