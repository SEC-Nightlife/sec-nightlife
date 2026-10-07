import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  countryFlag,
  dialCodeForCountry,
  joinPhoneNumber,
  listCountries,
  normalizeCountryCode,
  splitPhoneNumber,
} from '@/lib/countries';

/**
 * Country dialling-code picker + national number.
 * Emits a single string like "+27 11 784 0330" (or '' when the number is empty).
 */
export default function PhoneNumberInput({
  value,
  onChange,
  defaultCountry,
  placeholder = 'Phone number',
  className = '',
  inputClassName = 'h-12 bg-[#141416] border-[#262629] rounded-xl',
  disabled = false,
  id,
}) {
  const fallbackCountry = normalizeCountryCode(defaultCountry) || 'ZA';
  const initial = useMemo(() => splitPhoneNumber(value, fallbackCountry), []);
  const [countryCode, setCountryCode] = useState(initial.countryCode);
  const [national, setNational] = useState(initial.national);
  const lastEmitted = useRef(value || '');

  useEffect(() => {
    const incoming = value || '';
    if (incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    const parsed = splitPhoneNumber(incoming, countryCode || fallbackCountry);
    setCountryCode(parsed.countryCode);
    setNational(parsed.national);
  }, [value]);

  useEffect(() => {
    if (!national.trim() && fallbackCountry !== countryCode) setCountryCode(fallbackCountry);
  }, [fallbackCountry]);

  const countries = useMemo(
    () =>
      listCountries()
        .map((c) => ({ ...c, dial: dialCodeForCountry(c.code) }))
        .filter((c) => c.dial),
    [],
  );

  const emit = (nextCountry, nextNational) => {
    const joined = joinPhoneNumber(nextCountry, nextNational);
    lastEmitted.current = joined;
    onChange?.(joined);
  };

  const handleCountry = (e) => {
    const next = e.target.value;
    setCountryCode(next);
    emit(next, national);
  };

  const handleNational = (e) => {
    const raw = e.target.value;
    if (raw.trim().startsWith('+') && raw.replace(/\D/g, '').length > 4) {
      const parsed = splitPhoneNumber(raw, countryCode);
      setCountryCode(parsed.countryCode);
      setNational(parsed.national);
      emit(parsed.countryCode, parsed.national);
      return;
    }
    setNational(raw);
    emit(countryCode, raw);
  };

  const dial = dialCodeForCountry(countryCode);

  return (
    <div className={`flex gap-2 ${className}`}>
      <div className="relative shrink-0">
        <div
          aria-hidden
          className={`flex items-center gap-1.5 px-3 border ${inputClassName} ${disabled ? 'opacity-60' : ''}`}
        >
          <span className="text-base leading-none">{countryFlag(countryCode)}</span>
          <span className="text-sm text-[var(--sec-text-primary)] tabular-nums">+{dial}</span>
          <ChevronDown size={14} className="text-[var(--sec-text-muted)]" />
        </div>
        <select
          aria-label="Country code"
          value={countryCode}
          onChange={handleCountry}
          disabled={disabled}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        >
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {c.name} (+{c.dial})
            </option>
          ))}
        </select>
      </div>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder={placeholder}
        value={national}
        onChange={handleNational}
        disabled={disabled}
        className={`flex-1 min-w-0 ${inputClassName}`}
      />
    </div>
  );
}
