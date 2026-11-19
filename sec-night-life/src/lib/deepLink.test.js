import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathFromAppUrl } from './deepLink.js';
import { androidAppIntentUrl, iosAppSchemeUrl, openInAppHref, shouldOfferOpenInApp } from './openInApp.js';

const ticketUrl = 'https://secnightlife.com/TicketVerify?token=abc123&ec=DOOR';

describe('pathFromAppUrl', () => {
  it('keeps the https ticket path and query', () => {
    assert.equal(pathFromAppUrl(ticketUrl), '/TicketVerify?token=abc123&ec=DOOR');
  });

  it('accepts the secnightlife scheme used by the open-in-app button', () => {
    assert.equal(
      pathFromAppUrl('secnightlife://open/TicketVerify?token=abc123&ec=DOOR'),
      '/TicketVerify?token=abc123&ec=DOOR',
    );
  });

  it('accepts the venue scheme already used by venue pages', () => {
    assert.equal(pathFromAppUrl('secnightlife://venue?id=venue-1'), '/VenueProfile?id=venue-1');
  });

  it('ignores other hosts', () => {
    assert.equal(pathFromAppUrl('https://example.com/TicketVerify?token=abc'), null);
  });
});

describe('open in app href', () => {
  it('is hidden inside the native app and on desktop', () => {
    assert.equal(shouldOfferOpenInApp({ native: true, userAgent: 'iPhone' }), false);
    assert.equal(shouldOfferOpenInApp({ native: false, userAgent: 'Mozilla/5.0' }), false);
  });

  it('builds an Android intent that falls back to the same https page', () => {
    const href = openInAppHref(ticketUrl, { userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
    assert.equal(href, androidAppIntentUrl(ticketUrl));
    assert.match(href, /^intent:\/\/secnightlife\.com\/TicketVerify\?token=abc123&ec=DOOR#Intent;/);
    assert.match(href, /package=com\.secnightlife\.app/);
    assert.match(href, /browser_fallback_url=/);
  });

  it('builds an iPhone custom scheme for the same ticket path', () => {
    const href = openInAppHref(ticketUrl, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    assert.equal(href, iosAppSchemeUrl(ticketUrl));
    assert.equal(href, 'secnightlife://open/TicketVerify?token=abc123&ec=DOOR');
  });
});
