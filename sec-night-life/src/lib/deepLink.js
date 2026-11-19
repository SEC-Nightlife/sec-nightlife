/** Native deep link routing — registered from React Router inside App. */
let navigateFn = null;
let pendingPath = null;

export function registerDeepLinkNavigate(fn) {
  navigateFn = typeof fn === 'function' ? fn : null;
  if (navigateFn && pendingPath) {
    const path = pendingPath;
    pendingPath = null;
    navigateFn(path);
  }
}

export function handleDeepLinkPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return;
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (navigateFn) {
    navigateFn(path);
    return;
  }
  // Router may not be mounted yet (cold start from a QR scan).
  pendingPath = path;
}

function pathFromCustomScheme(parsed) {
  const host = String(parsed.hostname || '').toLowerCase();
  const search = parsed.search || '';
  const hash = parsed.hash || '';
  const pathname = parsed.pathname || '';
  if (host === 'open' && pathname && pathname !== '/') {
    return `${pathname}${search}${hash}`;
  }
  if (host === 'venue') return `/VenueProfile${search}${hash}`;
  if (host === 'ticket-verify' || host === 'ticketverify') return `/TicketVerify${search}${hash}`;
  if (pathname && pathname !== '/') return `${pathname}${search}${hash}`;
  return null;
}

/** Parse https://secnightlife.com/Path or secnightlife://open/Path from a Capacitor URL event. */
export function pathFromAppUrl(url) {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.replace(/:$/, '');
    if (protocol === 'secnightlife') return pathFromCustomScheme(parsed);
    const allowedHosts = new Set(['secnightlife.com', 'www.secnightlife.com']);
    if (!allowedHosts.has(parsed.hostname)) return null;
    const path = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
    return path === '/' ? null : path;
  } catch {
    return null;
  }
}
