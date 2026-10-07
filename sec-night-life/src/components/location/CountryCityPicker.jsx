import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Globe, MapPin, Loader2 } from 'lucide-react';
import { useGoogleMaps } from '@/lib/GoogleMapsProvider';
import { apiGet } from '@/api/client';
import { listCountries, normalizeCountryCode } from '@/lib/countries';

const inputClass = 'h-12 bg-[#141416] border-[#262629] rounded-xl';

function componentByType(components, type) {
  if (!Array.isArray(components)) return null;
  return components.find((c) => Array.isArray(c.types) && c.types.includes(type)) || null;
}

async function googleCitySuggestions(query, countryCode) {
  const places = window.google?.maps?.places;
  if (!places?.AutocompleteService) throw new Error('places unavailable');
  const service = new places.AutocompleteService();
  return new Promise((resolve, reject) => {
    service.getPlacePredictions(
      {
        input: query,
        types: ['(cities)'],
        ...(countryCode ? { componentRestrictions: { country: countryCode.toLowerCase() } } : {}),
      },
      (predictions, status) => {
        const ok = window.google.maps.places.PlacesServiceStatus;
        if (status === ok.ZERO_RESULTS) return resolve([]);
        if (status !== ok.OK || !Array.isArray(predictions)) return reject(new Error(String(status)));
        resolve(
          predictions.slice(0, 8).map((p) => ({
            placeId: p.place_id,
            city: p.structured_formatting?.main_text || p.description,
            label: p.description,
            region: null,
            country_code: countryCode || null,
            latitude: null,
            longitude: null,
          })),
        );
      },
    );
  });
}

async function googleResolvePlace(placeId) {
  const Geocoder = window.google?.maps?.Geocoder;
  if (!Geocoder) return null;
  const geocoder = new Geocoder();
  return new Promise((resolve) => {
    geocoder.geocode({ placeId }, (results, status) => {
      if (status !== 'OK' || !results?.[0]) return resolve(null);
      const r = results[0];
      const comps = r.address_components || [];
      const loc = r.geometry?.location;
      resolve({
        city:
          componentByType(comps, 'locality')?.long_name ||
          componentByType(comps, 'postal_town')?.long_name ||
          componentByType(comps, 'administrative_area_level_2')?.long_name ||
          '',
        region: componentByType(comps, 'administrative_area_level_1')?.long_name || null,
        country_code: componentByType(comps, 'country')?.short_name || null,
        latitude: loc ? loc.lat() : null,
        longitude: loc ? loc.lng() : null,
      });
    });
  });
}

async function apiCitySuggestions(query, countryCode) {
  const params = new URLSearchParams({ q: query });
  if (countryCode) params.set('country', countryCode);
  const data = await apiGet(`/api/map/search-cities?${params.toString()}`, { timeoutMs: 10000, skipAuth: true });
  return Array.isArray(data?.results) ? data.results : [];
}

/**
 * Country + city picker for any city worldwide.
 * value: { countryCode, city, region, latitude, longitude }
 */
export default function CountryCityPicker({
  value,
  onChange,
  countryLabel = 'Country',
  cityLabel = 'City',
  cityPlaceholder = 'Start typing your city',
  required = false,
  disabled = false,
  showRegion = false,
}) {
  const countries = useMemo(() => listCountries('en'), []);
  const { status: mapsStatus } = useGoogleMaps();
  const countryCode = normalizeCountryCode(value?.countryCode) || '';
  const [draft, setDraft] = useState(value?.city || '');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const skipNextSearch = useRef(false);

  useEffect(() => {
    setDraft(value?.city || '');
  }, [value?.city]);

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return undefined;
    }
    const q = draft.trim();
    if (q.length < 2 || q === (value?.city || '')) {
      setSuggestions([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        let rows = [];
        if (mapsStatus === 'ready') {
          try {
            rows = await googleCitySuggestions(q, countryCode);
          } catch {
            rows = await apiCitySuggestions(q, countryCode);
          }
        } else {
          rows = await apiCitySuggestions(q, countryCode);
        }
        if (!cancelled) {
          setSuggestions(rows);
          setOpen(true);
        }
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, countryCode, mapsStatus, value?.city]);

  const emit = (patch) => onChange?.({ ...(value || {}), ...patch });

  const pick = async (item) => {
    skipNextSearch.current = true;
    setOpen(false);
    setSuggestions([]);
    let resolved = item;
    if (item.placeId) {
      const detail = await googleResolvePlace(item.placeId).catch(() => null);
      if (detail) resolved = { ...item, ...detail, city: detail.city || item.city };
    }
    setDraft(resolved.city || '');
    emit({
      city: resolved.city || '',
      region: resolved.region ?? value?.region ?? null,
      countryCode: normalizeCountryCode(resolved.country_code) || countryCode || null,
      latitude: resolved.latitude ?? null,
      longitude: resolved.longitude ?? null,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-gray-400 text-sm flex items-center gap-2">
          <Globe className="w-4 h-4" />
          {countryLabel}
          {required ? <span className="text-red-400">*</span> : null}
        </Label>
        <select
          value={countryCode}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value || null;
            if (next === countryCode) return;
            setDraft('');
            emit({ countryCode: next, city: '', region: null, latitude: null, longitude: null });
          }}
          className={`mt-2 w-full px-3 text-[16px] text-white ${inputClass} border`}
        >
          <option value="">Select a country</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="relative">
        <Label className="text-gray-400 text-sm flex items-center gap-2">
          <MapPin className="w-4 h-4" />
          {cityLabel}
          {required ? <span className="text-red-400">*</span> : null}
        </Label>
        <Input
          value={draft}
          disabled={disabled || !countryCode}
          placeholder={countryCode ? cityPlaceholder : 'Choose a country first'}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            emit({ city: next, latitude: null, longitude: null });
          }}
          onFocus={() => suggestions.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          className={`mt-2 ${inputClass}`}
          autoComplete="off"
        />
        {searching ? (
          <Loader2 className="w-4 h-4 animate-spin text-gray-500 absolute right-3 top-[46px]" />
        ) : null}
        {open && suggestions.length > 0 ? (
          <ul
            className="absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-auto rounded-xl border border-[#262629] bg-[#141416] shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((item) => (
              <li key={item.placeId || `${item.city}-${item.region}-${item.latitude}`}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2.5 text-sm text-gray-200 hover:bg-[#1c1c1f]"
                  onClick={() => pick(item)}
                >
                  <span className="font-medium">{item.city}</span>
                  {item.label && item.label !== item.city ? (
                    <span className="block text-xs text-gray-500 truncate">{item.label}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {showRegion ? (
        <div>
          <Label className="text-gray-400 text-sm">State / province / region</Label>
          <Input
            value={value?.region || ''}
            disabled={disabled}
            placeholder="Optional"
            onChange={(e) => emit({ region: e.target.value || null })}
            className={`mt-2 ${inputClass}`}
          />
        </div>
      ) : null}
    </div>
  );
}
