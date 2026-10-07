import { loadGoogleMapsApi } from '@/lib/googleMapsApi';
import { apiGet } from '@/api/client';

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function coordFallback(latN, lngN) {
  return `${latN.toFixed(5)}, ${lngN.toFixed(5)}`;
}

function componentByType(addressComponents, typeName) {
  if (!Array.isArray(addressComponents)) return null;
  return addressComponents.find((c) => Array.isArray(c.types) && c.types.includes(typeName)) || null;
}

function parseGoogleResult(result, latN, lngN) {
  const formattedAddress = result?.formatted_address || '';
  const addressComponents = result?.address_components || [];

  const streetNumber = componentByType(addressComponents, 'street_number')?.long_name;
  const route = componentByType(addressComponents, 'route')?.long_name;
  const street = [streetNumber, route].filter(Boolean).join(' ').trim() || route || '';

  // Prefer true neighbourhood/sublocality — avoid using city/postal_town as "suburb".
  const suburb =
    componentByType(addressComponents, 'neighborhood')?.long_name ||
    componentByType(addressComponents, 'sublocality')?.long_name ||
    componentByType(addressComponents, 'sublocality_level_1')?.long_name ||
    '';

  const city =
    componentByType(addressComponents, 'locality')?.long_name ||
    componentByType(addressComponents, 'postal_town')?.long_name ||
    componentByType(addressComponents, 'administrative_area_level_2')?.long_name ||
    '';

  const province = componentByType(addressComponents, 'administrative_area_level_1')?.long_name || '';
  const countryShort = componentByType(addressComponents, 'country')?.short_name || '';

  const primary =
    street ||
    [suburb, city].filter(Boolean).join(', ') ||
    formattedAddress ||
    coordFallback(latN, lngN);

  return {
    formattedAddress: primary,
    street: street || primary,
    suburb: suburb || city || '',
    city,
    province,
    country: countryShort ? countryShort.toUpperCase() : null,
    latitude: latN,
    longitude: lngN,
  };
}

async function reverseViaGoogleStructured(latN, lngN) {
  if (typeof window !== 'undefined' && window.__googleMapsAuthFailure) {
    throw new Error('Google Maps authentication failed.');
  }

  await withTimeout(loadGoogleMapsApi(), 6000, 'Google Maps load timed out');

  if (typeof window !== 'undefined' && window.__googleMapsAuthFailure) {
    throw new Error('Google Maps authentication failed.');
  }
  if (!window.google?.maps?.Geocoder) {
    throw new Error('Geocoder unavailable');
  }

  const geocoder = new window.google.maps.Geocoder();
  return withTimeout(
    new Promise((resolve, reject) => {
      geocoder.geocode({ location: { lat: latN, lng: lngN } }, (results, status) => {
        if (status === 'OK' && results?.[0]) {
          resolve(parseGoogleResult(results[0], latN, lngN));
          return;
        }
        reject(new Error(status || 'Geocode failed'));
      });
    }),
    5000,
    'Google reverse geocode timed out'
  );
}

async function reverseViaApiStructured(latN, lngN) {
  const data = await apiGet(
    `/api/map/reverse-geocode?lat=${encodeURIComponent(latN)}&lng=${encodeURIComponent(lngN)}`,
    { timeoutMs: 10000, skipAuth: true }
  );
  const formatted =
    (typeof data?.formattedAddress === 'string' && data.formattedAddress.trim()) ||
    (typeof data?.label === 'string' && data.label.trim()) ||
    '';
  if (!formatted) throw new Error('No label from API');
  return {
    formattedAddress: formatted,
    street: (typeof data?.street === 'string' && data.street.trim()) || formatted,
    suburb: typeof data?.suburb === 'string' ? data.suburb : '',
    city: typeof data?.city === 'string' ? data.city : '',
    province: typeof data?.province === 'string' ? data.province : '',
    country: data?.country || null,
    latitude: latN,
    longitude: lngN,
  };
}

/**
 * Reverse-geocode lat/lng to a human-readable address string.
 */
export async function reverseGeocodeLatLng(lat, lng) {
  const structured = await reverseGeocodeLatLngStructured(lat, lng);
  return structured?.formattedAddress || '';
}

/**
 * Reverse-geocode to a structured address object (suburb/province when available).
 * Prefers fresh GPS-aligned Google result, then Nominatim with address details.
 */
export async function reverseGeocodeLatLngStructured(lat, lng) {
  const latN = Number(lat);
  const lngN = Number(lng);
  const fallback = {
    formattedAddress: coordFallback(latN, lngN),
    street: coordFallback(latN, lngN),
    suburb: '',
    city: '',
    province: '',
    country: null,
    latitude: latN,
    longitude: lngN,
  };
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    return { ...fallback, formattedAddress: '', street: '', latitude: null, longitude: null };
  }

  try {
    return (await reverseViaGoogleStructured(latN, lngN)) || fallback;
  } catch {
    // fall through
  }

  try {
    return (await reverseViaApiStructured(latN, lngN)) || fallback;
  } catch {
    return fallback;
  }
}
