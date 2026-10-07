import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MapPin } from 'lucide-react';

import { useGoogleMaps } from '@/lib/GoogleMapsProvider';
import { apiGet } from '@/api/client';

function componentByType(addressComponents, typeName) {
  if (!Array.isArray(addressComponents)) return null;
  return addressComponents.find((c) => Array.isArray(c.types) && c.types.includes(typeName)) || null;
}

function parsePlaceToStructured(place) {
  if (!place) return null;

  const formattedAddress = place.formatted_address || '';
  const addressComponents = place.address_components || [];

  const streetNumber = componentByType(addressComponents, 'street_number')?.long_name;
  const route = componentByType(addressComponents, 'route')?.long_name;
  const street = [streetNumber, route].filter(Boolean).join(' ').trim() || route || formattedAddress;

  const suburb =
    componentByType(addressComponents, 'neighborhood')?.long_name ||
    componentByType(addressComponents, 'sublocality')?.long_name ||
    componentByType(addressComponents, 'sublocality_level_1')?.long_name ||
    componentByType(addressComponents, 'postal_town')?.long_name ||
    '';

  const city =
    componentByType(addressComponents, 'locality')?.long_name ||
    componentByType(addressComponents, 'postal_town')?.long_name ||
    componentByType(addressComponents, 'administrative_area_level_2')?.long_name ||
    '';

  const province = componentByType(addressComponents, 'administrative_area_level_1')?.long_name || '';
  const country = componentByType(addressComponents, 'country')?.short_name || '';

  const lat = place.geometry?.location?.lat ? place.geometry.location.lat() : null;
  const lng = place.geometry?.location?.lng ? place.geometry.location.lng() : null;

  const normalizedCountry = typeof country === 'string' && country ? country.toUpperCase() : null;

  return {
    formattedAddress,
    street,
    suburb,
    city,
    province,
    country: normalizedCountry,
    latitude: typeof lat === 'number' ? lat : null,
    longitude: typeof lng === 'number' ? lng : null,
  };
}

function toStructuredValue(value, countryCode = null) {
  if (!value) return null;
  if (typeof value === 'string') {
    return {
      formattedAddress: value,
      street: value,
      suburb: '',
      city: '',
      province: '',
      country: countryCode,
      latitude: null,
      longitude: null,
    };
  }
  return value;
}

function FallbackAddressInput({
  draft,
  setDraft,
  structuredValue,
  onChange,
  onCoordinatesChange,
  placeholder,
  setStructuredFromDraft,
  restrictCountry,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef(null);

  useEffect(() => {
    const q = (draft || '').trim();
    if (q.length < 3) {
      setSuggestions([]);
      setSearching(false);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const countryParam = restrictCountry ? `&country=${encodeURIComponent(restrictCountry)}` : '';
        const data = await apiGet(
          `/api/map/search-places?q=${encodeURIComponent(q)}${countryParam}`,
          { timeoutMs: 10000, skipAuth: true }
        );
        if (!cancelled) {
          setSuggestions(Array.isArray(data?.results) ? data.results : []);
          setOpen(true);
        }
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, restrictCountry]);

  const pickSuggestion = (item) => {
    setDraft(item.formattedAddress || '');
    onChange(item);
    if (onCoordinatesChange) {
      onCoordinatesChange({
        latitude: item.latitude,
        longitude: item.longitude,
        address: item.formattedAddress,
      });
    }
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div className="mt-2 space-y-4 relative">
      <div>
        <Input
          placeholder={placeholder}
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            setStructuredFromDraft(next);
            setOpen(true);
          }}
          onFocus={() => {
            if (suggestions.length) setOpen(true);
          }}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 180);
          }}
          className="mt-0 h-12 bg-[#141416] border-[#262629] rounded-xl"
        />
        <p className="text-xs text-gray-500 mt-1">
          {searching ? 'Searching places…' : 'Start typing to see place suggestions'}
        </p>
        {open && suggestions.length > 0 ? (
          <ul
            className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-auto rounded-xl border border-[#262629] bg-[#141416] shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((item) => (
              <li key={`${item.latitude}-${item.longitude}-${item.formattedAddress}`}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2.5 text-sm text-gray-200 hover:bg-[#1c1c1f]"
                  onClick={() => pickSuggestion(item)}
                >
                  {item.formattedAddress}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-gray-400 text-xs">Suburb / area</Label>
          <Input
            placeholder="Neighbourhood"
            value={structuredValue?.suburb || ''}
            onChange={(e) => onChange({ ...(structuredValue || toStructuredValue('')), suburb: e.target.value })}
            className="mt-2 h-12 bg-[#141416] border-[#262629] rounded-xl"
          />
        </div>
        <div>
          <Label className="text-gray-400 text-xs">State / province / region</Label>
          <Input
            placeholder="Region"
            value={structuredValue?.province || ''}
            onChange={(e) => onChange({ ...(structuredValue || toStructuredValue('')), province: e.target.value })}
            className="mt-2 h-12 bg-[#141416] border-[#262629] rounded-xl"
          />
        </div>
      </div>
    </div>
  );
}

export default function GoogleAddressInput({
  value,
  onChange,
  onCoordinatesChange,
  placeholder = 'Enter address',
  label = 'Full Address',
  /** Always show Suburb / Province fields (not only Maps fallback). */
  showSuburbProvince = false,
  /** ISO alpha-2 country to restrict suggestions to; omit for worldwide. */
  countryCode = null,
}) {
  const restrictCountry =
    typeof countryCode === 'string' && /^[A-Za-z]{2}$/.test(countryCode) ? countryCode.toLowerCase() : null;
  const inputRef = useRef(null);
  const [autocomplete, setAutocomplete] = useState(null);
  const { status: mapsStatus } = useGoogleMaps();

  const structuredValue = useMemo(() => toStructuredValue(value), [value]);
  const [draft, setDraft] = useState(structuredValue?.formattedAddress || '');

  useEffect(() => {
    setDraft(structuredValue?.formattedAddress || '');
  }, [structuredValue?.formattedAddress]);

  useEffect(() => {
    if (mapsStatus !== 'ready') return;
    if (!inputRef.current) return;
    if (!window.google?.maps?.places) return;
    if (autocomplete) return;

    const autocompleteInstance = new window.google.maps.places.Autocomplete(inputRef.current, {
      types: ['address'],
      ...(restrictCountry ? { componentRestrictions: { country: restrictCountry } } : {}),
    });

    autocompleteInstance.addListener('place_changed', () => {
      const place = autocompleteInstance.getPlace();
      const structured = parsePlaceToStructured(place);
      if (!structured) return;

      setDraft(structured.formattedAddress || '');
      onChange(structured);

      if (onCoordinatesChange) {
        onCoordinatesChange({
          latitude: structured.latitude,
          longitude: structured.longitude,
          address: structured.formattedAddress,
        });
      }
    });

    setAutocomplete(autocompleteInstance);
  }, [mapsStatus, autocomplete, onChange, onCoordinatesChange, restrictCountry]);

  useEffect(() => {
    if (!autocomplete) return;
    autocomplete.setComponentRestrictions(restrictCountry ? { country: restrictCountry } : null);
  }, [autocomplete, restrictCountry]);

  const setStructuredFromDraft = (nextDraft) => {
    const base = structuredValue || toStructuredValue('');
    const next = {
      ...base,
      formattedAddress: nextDraft,
      street: nextDraft,
      latitude: null,
      longitude: null,
    };
    onChange(next);
    if (onCoordinatesChange) {
      onCoordinatesChange({ latitude: null, longitude: null, address: nextDraft });
    }
  };

  const useFallback = mapsStatus === 'error';

  const suburbProvinceFields = showSuburbProvince && !useFallback ? (
    <div className="grid grid-cols-2 gap-4 mt-3">
      <div>
        <Label className="text-gray-400 text-xs">Suburb / area</Label>
        <Input
          placeholder="Neighbourhood"
          value={structuredValue?.suburb || ''}
          onChange={(e) =>
            onChange({ ...(structuredValue || toStructuredValue('')), suburb: e.target.value })
          }
          className="mt-2 h-12 bg-[#141416] border-[#262629] rounded-xl"
        />
      </div>
      <div>
        <Label className="text-gray-400 text-xs">State / province / region</Label>
        <Input
          placeholder="Region"
          value={structuredValue?.province || ''}
          onChange={(e) =>
            onChange({ ...(structuredValue || toStructuredValue('')), province: e.target.value })
          }
          className="mt-2 h-12 bg-[#141416] border-[#262629] rounded-xl"
        />
      </div>
    </div>
  ) : null;

  return (
    <div>
      <Label className="text-gray-400 text-sm flex items-center gap-2">
        <MapPin className="w-4 h-4" />
        {label}
      </Label>

      {useFallback ? (
        <FallbackAddressInput
          draft={draft}
          setDraft={setDraft}
          structuredValue={structuredValue}
          onChange={onChange}
          onCoordinatesChange={onCoordinatesChange}
          placeholder={placeholder}
          setStructuredFromDraft={setStructuredFromDraft}
          restrictCountry={restrictCountry}
        />
      ) : (
        <>
          <Input
            ref={inputRef}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => {
              const nextDraft = e.target.value;
              setDraft(nextDraft);
              setStructuredFromDraft(nextDraft);
            }}
            className="mt-2 h-12 bg-[#141416] border-[#262629] rounded-xl"
          />
          <p className="text-xs text-gray-500 mt-1">
            {mapsStatus === 'loading' ? 'Loading maps...' : 'Start typing to see address suggestions'}
          </p>
          {suburbProvinceFields}
        </>
      )}
    </div>
  );
}
