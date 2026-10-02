/**
 * SEC service fee — flat amount added on top of paid checkouts (not on free claims).
 * Keep in sync with backend/src/lib/serviceFee.js — the server rejects mismatched totals.
 */
export const SERVICE_FEE_ZAR = 5;
export const SERVICE_FEE_LABEL = 'SEC service fee';
export const SERVICE_FEE_LINE_CODE = 'service_fee';

function roundZar(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function serviceFeeForSubtotal(subtotalZar) {
  return roundZar(subtotalZar) > 0 ? SERVICE_FEE_ZAR : 0;
}

/** Subtotal + flat fee, rounded to cents. */
export function totalWithServiceFee(subtotalZar) {
  const subtotal = roundZar(subtotalZar);
  return roundZar(subtotal + serviceFeeForSubtotal(subtotal));
}

export function isServiceFeeLine(line) {
  return line?.code === SERVICE_FEE_LINE_CODE;
}
