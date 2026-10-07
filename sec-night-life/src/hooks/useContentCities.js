import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';

/**
 * Cities that currently have content (events, venues, vendors, jobs, promotions, tables),
 * optionally limited to one country. Replaces hard-coded city lists in filters.
 */
export function useContentCities({ source = 'all', countryCode = null, enabled = true } = {}) {
  const { data, isLoading } = useQuery({
    queryKey: ['content-cities', source, countryCode || '*'],
    queryFn: () => {
      const params = new URLSearchParams({ source });
      if (countryCode) params.set('country_code', countryCode);
      return apiGet(`/api/locations/cities?${params.toString()}`, { skipAuth: true });
    },
    enabled,
    staleTime: 5 * 60_000,
  });
  const cities = Array.isArray(data?.cities) ? data.cities.map((c) => c.city) : [];
  return { cities, isLoading };
}

/** Merge server cities with any city names seen in already-loaded rows. */
export function mergeCityLabels(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const raw of list || []) {
      if (!raw || typeof raw !== 'string') continue;
      const t = raw.trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (!byKey.has(k)) byKey.set(k, t);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}
