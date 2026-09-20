/**
 * Native shell setup — status bar, splash screen, deep links (Capacitor only).
 */
import { Capacitor } from '@capacitor/core';
import { handleDeepLinkPath, pathFromAppUrl } from '@/lib/deepLink';

let splashHideScheduled = false;

/** Hide Capacitor splash after web first paint (iOS LaunchScreen already showed SEC assets). */
export async function hideNativeSplash() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 200 });
  } catch (err) {
    console.warn('[native] splash hide:', err?.message || err);
  }
}

export async function initNativeShell() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#000000' });
  } catch (err) {
    console.warn('[native] status bar:', err?.message || err);
  }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    // Android: launchShowDuration 0 — hide on a short timer to avoid stuck splash races.
    // iOS: LaunchScreen uses SEC Splash.imageset; hide after first paint via removeBootSplash,
    // with a safety timeout so the native splash never sticks.
    if (Capacitor.getPlatform() === 'android') {
      const hideSplash = () => {
        SplashScreen.hide().catch(() => {});
      };
      window.setTimeout(hideSplash, 0);
      window.setTimeout(hideSplash, 300);
      window.setTimeout(hideSplash, 1500);
    } else if (!splashHideScheduled) {
      splashHideScheduled = true;
      window.setTimeout(() => {
        void hideNativeSplash();
      }, 2500);
    }
  } catch (err) {
    console.warn('[native] splash:', err?.message || err);
  }

  try {
    const { App } = await import('@capacitor/app');
    await App.addListener('appUrlOpen', (event) => {
      const path = pathFromAppUrl(event?.url);
      if (path) handleDeepLinkPath(path);
    });
  } catch (err) {
    console.warn('[native] deep link listener:', err?.message || err);
  }
}
