import tzlookup from 'tz-lookup';

export const DEFAULT_COUNTRY_CODE = 'ZA';
export const DEFAULT_TIMEZONE = 'Africa/Johannesburg';

/** Fallback zone when a venue has no coordinates (largest-population zone per country). */
const COUNTRY_DEFAULT_TIMEZONE = {
  ZA: 'Africa/Johannesburg',
  NA: 'Africa/Windhoek',
  BW: 'Africa/Gaborone',
  ZW: 'Africa/Harare',
  MZ: 'Africa/Maputo',
  LS: 'Africa/Maseru',
  SZ: 'Africa/Mbabane',
  ZM: 'Africa/Lusaka',
  KE: 'Africa/Nairobi',
  NG: 'Africa/Lagos',
  GH: 'Africa/Accra',
  EG: 'Africa/Cairo',
  MA: 'Africa/Casablanca',
  TZ: 'Africa/Dar_es_Salaam',
  UG: 'Africa/Kampala',
  RW: 'Africa/Kigali',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  IT: 'Europe/Rome',
  CH: 'Europe/Zurich',
  AT: 'Europe/Vienna',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw',
  GR: 'Europe/Athens',
  TR: 'Europe/Istanbul',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  QA: 'Asia/Qatar',
  IN: 'Asia/Kolkata',
  SG: 'Asia/Singapore',
  TH: 'Asia/Bangkok',
  JP: 'Asia/Tokyo',
  CN: 'Asia/Shanghai',
  HK: 'Asia/Hong_Kong',
  KR: 'Asia/Seoul',
  ID: 'Asia/Jakarta',
  PH: 'Asia/Manila',
  MY: 'Asia/Kuala_Lumpur',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
  US: 'America/New_York',
  CA: 'America/Toronto',
  MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  CO: 'America/Bogota',
  CL: 'America/Santiago',
  PE: 'America/Lima',
};

/** Normalise to an upper-case ISO 3166-1 alpha-2 code, or null. */
export function normalizeCountryCode(value) {
  if (value == null) return null;
  const code = String(value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timezoneForCountry(countryCode) {
  const code = normalizeCountryCode(countryCode);
  return (code && COUNTRY_DEFAULT_TIMEZONE[code]) || null;
}

/**
 * Resolve an IANA time zone from coordinates, then the country default, then SAST.
 */
export function resolveTimeZone({ latitude, longitude, countryCode } = {}) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (
    latitude != null &&
    longitude != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  ) {
    try {
      const tz = tzlookup(lat, lng);
      if (isValidTimeZone(tz)) return tz;
    } catch {
      /* fall through */
    }
  }
  return timezoneForCountry(countryCode) || DEFAULT_TIMEZONE;
}

/** Venue/event zone with safe fallback for legacy rows. */
export function zoneOf(row) {
  const tz = row?.timezone;
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/**
 * Wall-clock parts (year, month, day, hour, minute, weekday 0-6) of `date` in `timeZone`.
 */
export function zonedParts(date, timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: weekdays[out.weekday] ?? 0,
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `date`. */
export function zoneOffsetMs(date, timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const p = zonedParts(d, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/**
 * UTC instant for a wall-clock time in `timeZone` (DST-safe: re-checks offset once).
 */
export function zonedWallTimeToUtc(year, month, day, hour = 0, minute = 0, timeZone = DEFAULT_TIMEZONE) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let utc = guess - offset;
  const offset2 = zoneOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

/** YYYY-MM-DD for `date` in `timeZone`. */
export function zonedYmd(date, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Calendar day of a stored "date" value. Date-only inputs ("2026-10-07") are stored at UTC midnight,
 * so those keep their UTC day; any other instant is read in `timeZone`.
 */
export function calendarParts(date, timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  const p = zonedParts(d, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** UTC instant for calendar `date` + "HH:mm" wall time in `timeZone` (null when unusable). */
export function zonedDateTimeToUtc(date, hhmm, timeZone = DEFAULT_TIMEZONE) {
  const cal = calendarParts(date, timeZone);
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!cal || !m) return null;
  const out = zonedWallTimeToUtc(cal.year, cal.month, cal.day, Number(m[1]), Number(m[2]), timeZone);
  return Number.isNaN(out.getTime()) ? null : out;
}

/** First valid zone on a row or its venue / event / event venue (falls back to SAST). */
export function zoneFrom(...rows) {
  for (const row of rows) {
    if (!row) continue;
    for (const tz of [row.timezone, row.venue?.timezone, row.event?.timezone, row.event?.venue?.timezone]) {
      if (isValidTimeZone(tz)) return tz;
    }
  }
  return DEFAULT_TIMEZONE;
}

/** Hosted tables have no zone column: use the event/venue zone, else derive from own-place location. */
export function zoneOfHostedTable(t) {
  if (!t) return DEFAULT_TIMEZONE;
  for (const tz of [t.event?.timezone, t.event?.venue?.timezone, t.venue?.timezone, t.venueTable?.venue?.timezone]) {
    if (isValidTimeZone(tz)) return tz;
  }
  if (t.latitude != null || t.countryCode) {
    return resolveTimeZone({ latitude: t.latitude, longitude: t.longitude, countryCode: t.countryCode });
  }
  return DEFAULT_TIMEZONE;
}

/** Short zone label for `date` in `timeZone`, e.g. "SAST", "GMT+1", "EDT". */
export function zoneAbbreviation(date, timeZone = DEFAULT_TIMEZONE) {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  if (tz === 'Africa/Johannesburg') return 'SAST';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(date instanceof Date ? date : new Date(date))
      .find((p) => p.type === 'timeZoneName');
    return part?.value || tz;
  } catch {
    return tz;
  }
}
