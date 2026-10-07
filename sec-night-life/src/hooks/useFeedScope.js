import { useMemo } from 'react';
import { usePreferences } from '@/context/PreferencesContext';

export const FEED_SCOPE_LABELS = {
  local: 'Near me',
  national: 'My country',
  worldwide: 'Worldwide',
};

/**
 * Query params for scope-aware list endpoints (`feed_scope`, `country_code`, `city`, geo).
 * The server falls back to the signed-in profile when country/city are missing.
 */
export function useFeedScopeParams() {
  const { feedScope, viewerCountryCode, viewerCity, geoCoords, location } = usePreferences();
  return useMemo(() => {
    const params = { feed_scope: feedScope };
    if (feedScope !== 'worldwide' && viewerCountryCode) params.country_code = viewerCountryCode;
    if (feedScope === 'local') {
      if (geoCoords) {
        params.lat = geoCoords.lat.toFixed(4);
        params.lng = geoCoords.lng.toFixed(4);
        params.radius_km = String(location?.radiusKm || 25);
      } else if (viewerCity) {
        params.city = viewerCity;
      }
    }
    const key = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return {
      feedScope,
      countryCode: viewerCountryCode,
      city: viewerCity,
      params,
      key,
      toQueryString: (extra = {}) => new URLSearchParams({ ...params, ...extra }).toString(),
    };
  }, [feedScope, viewerCountryCode, viewerCity, geoCoords, location?.radiusKm]);
}
