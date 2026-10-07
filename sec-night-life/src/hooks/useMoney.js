import { useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import { PreferencesContext } from '@/context/PreferencesContext';
import { currencyForCountry } from '@/lib/countries';
import { BASE_CURRENCY, formatMoney, formatZar } from '@/lib/money';

/** ZAR-based display rates; refreshed server-side every 12 hours. */
export function useFxRates(enabled = true) {
  return useQuery({
    queryKey: ['fx-rates'],
    queryFn: () => apiGet('/api/fx/rates', { skipAuth: true }),
    enabled,
    staleTime: 6 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: 1,
  });
}

/**
 * Price formatting in the viewer's display currency (App Preferences, else their country's currency).
 * `format` converts and marks the value approximate; `formatZar` is for what is actually charged.
 */
export function useMoney() {
  const prefs = useContext(PreferencesContext);
  const wanted = prefs?.displayCurrency || currencyForCountry(prefs?.viewerCountryCode) || BASE_CURRENCY;
  const { data } = useFxRates(wanted !== BASE_CURRENCY);
  const rates = data?.rates || null;
  const isConverted = wanted !== BASE_CURRENCY && Number(rates?.[wanted]) > 0;
  const currency = isConverted ? wanted : BASE_CURRENCY;

  return useMemo(
    () => ({
      currency,
      isConverted,
      format: (amountZar) => formatMoney(amountZar, { currency, rates }),
      /** Display price plus the rand amount, e.g. "≈ $12 (R220)". */
      formatWithZar: (amountZar) =>
        isConverted ? `${formatMoney(amountZar, { currency, rates })} (${formatZar(amountZar)})` : formatZar(amountZar),
      formatZar,
    }),
    [currency, isConverted, rates],
  );
}
