/** Prices are stored and charged in ZAR. Other currencies are display-only conversions. */
export const BASE_CURRENCY = 'ZAR';

function hasCents(v) {
  return Math.round(v * 100) % 100 !== 0;
}

/** Format a rand amount, e.g. 1500 → "R1 500" (en-ZA grouping), 99.5 → "R99.50". */
export function formatZar(n, { cents } = {}) {
  const v = Number(n) || 0;
  const showCents = cents ?? hasCents(v);
  return `R${v.toLocaleString('en-ZA', {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Convert a rand amount with ZAR-based rates (1 ZAR = rates[X] X). Null when the rate is unknown. */
export function convertFromZar(amountZar, currency, rates) {
  const v = Number(amountZar);
  if (!Number.isFinite(v)) return null;
  if (!currency || currency === BASE_CURRENCY) return v;
  const rate = Number(rates?.[currency]);
  return Number.isFinite(rate) && rate > 0 ? v * rate : null;
}

/** Locale-aware currency formatting (user's locale by default). */
export function formatCurrency(amount, currency, { locale } = {}) {
  const v = Number(amount) || 0;
  try {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: hasCents(v) ? Math.min(2, digits) : 0,
      maximumFractionDigits: hasCents(v) ? digits : 0,
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

/**
 * Format a rand amount in the viewer's display currency. Converted values are marked
 * approximate ("≈ $12"); without a rate it falls back to rand.
 */
export function formatMoney(amountZar, { currency = BASE_CURRENCY, rates = null, approx = true, locale } = {}) {
  if (!currency || currency === BASE_CURRENCY) return formatZar(amountZar);
  const converted = convertFromZar(amountZar, currency, rates);
  if (converted == null) return formatZar(amountZar);
  return `${approx ? '≈ ' : ''}${formatCurrency(converted, currency, { locale })}`;
}

/** Display currency options (unique ISO 4217 codes) with localised names. */
export function listCurrencies(codes, locale = 'en') {
  let names = null;
  try {
    names = new Intl.DisplayNames([locale], { type: 'currency' });
  } catch {
    names = null;
  }
  return [...new Set(codes)]
    .map((code) => ({ code, name: names?.of(code) || code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}
