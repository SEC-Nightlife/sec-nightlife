import { cacheGetJson, cacheSetJson } from './redis.js';
import { logger } from './logger.js';

/** All prices are stored and charged in ZAR; other currencies are display-only conversions. */
export const FX_BASE = 'ZAR';
const TTL_SECONDS = 12 * 60 * 60;
const CACHE_KEY = 'fx:rates:ZAR:v1';
const FETCH_TIMEOUT_MS = 6000;

let memo = null;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`FX source ${res.status}`);
  return res.json();
}

function cleanRates(raw) {
  const rates = {};
  for (const [code, value] of Object.entries(raw || {})) {
    const n = Number(value);
    if (/^[A-Z]{3}$/.test(code) && Number.isFinite(n) && n > 0) rates[code] = n;
  }
  rates[FX_BASE] = 1;
  return rates;
}

/** open.er-api covers ~160 currencies; Frankfurter (ECB) is the fallback for the majors. */
async function fetchRates() {
  try {
    const data = await fetchJson(`https://open.er-api.com/v6/latest/${FX_BASE}`);
    if (data?.result === 'success' && data.rates) {
      return { rates: cleanRates(data.rates), source: 'open.er-api.com' };
    }
  } catch (err) {
    logger.warn('[fx] open.er-api failed', { message: err?.message });
  }
  const data = await fetchJson(`https://api.frankfurter.app/latest?from=${FX_BASE}`);
  return { rates: cleanRates(data?.rates), source: 'frankfurter.app' };
}

/** ZAR-based rates (1 ZAR = rates[X] X), cached for 12 hours. Serves stale rates if refresh fails. */
export async function getFxRates() {
  const now = Date.now();
  if (memo && now - memo.fetchedAt < TTL_SECONDS * 1000) return memo.payload;
  const cached = await cacheGetJson(CACHE_KEY).catch(() => null);
  if (cached?.rates && now - Date.parse(cached.updatedAt) < TTL_SECONDS * 1000) {
    memo = { fetchedAt: Date.parse(cached.updatedAt), payload: cached };
    return cached;
  }
  try {
    const { rates, source } = await fetchRates();
    const payload = { base: FX_BASE, rates, source, updatedAt: new Date(now).toISOString() };
    memo = { fetchedAt: now, payload };
    await cacheSetJson(CACHE_KEY, payload, TTL_SECONDS).catch(() => {});
    return payload;
  } catch (err) {
    logger.warn('[fx] refresh failed', { message: err?.message });
    if (memo) return memo.payload;
    if (cached?.rates) return cached;
    return { base: FX_BASE, rates: { [FX_BASE]: 1 }, source: null, updatedAt: null };
  }
}
