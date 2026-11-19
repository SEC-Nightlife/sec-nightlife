const ANDROID_PACKAGE = 'com.secnightlife.app';

export function shouldOfferOpenInApp({ native = false, userAgent = '' } = {}) {
  if (native) return false;
  return /Android|iPhone|iPad|iPod/i.test(userAgent);
}

/** Android App Link intent. Falls back to the same https page when the app is not installed. */
export function androidAppIntentUrl(pageUrl) {
  const parsed = new URL(pageUrl);
  const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
  const relative = path.startsWith('/') ? path.slice(1) : path;
  const fallback = encodeURIComponent(parsed.toString());
  return `intent://secnightlife.com/${relative}#Intent;scheme=https;package=${ANDROID_PACKAGE};S.browser_fallback_url=${fallback};end`;
}

/** Custom scheme the native app claims. Requires a store build that registers secnightlife://. */
export function iosAppSchemeUrl(pageUrl) {
  const parsed = new URL(pageUrl);
  return `secnightlife://open${parsed.pathname || '/'}${parsed.search || ''}`;
}

export function openInAppHref(pageUrl, { userAgent = '' } = {}) {
  if (/Android/i.test(userAgent)) return androidAppIntentUrl(pageUrl);
  if (/iPhone|iPad|iPod/i.test(userAgent)) return iosAppSchemeUrl(pageUrl);
  return null;
}
