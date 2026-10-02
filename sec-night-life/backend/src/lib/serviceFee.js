/**
 * SEC service fee — a flat amount the customer pays on top of the checkout subtotal.
 * 100% SEC revenue; never part of the venue/host gross used for splits, payouts, or refunds.
 * Keep in sync with src/lib/serviceFee.js (frontend).
 */
export const SERVICE_FEE_ZAR = 5;
export const SERVICE_FEE_LINE_CODE = 'service_fee';
export const SERVICE_FEE_LABEL = 'SEC service fee';

function roundZar(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Flat fee for any paid checkout; free (R0) checkouts pay nothing. */
export function serviceFeeForSubtotal(subtotalZar) {
  return roundZar(subtotalZar) > 0 ? SERVICE_FEE_ZAR : 0;
}

export function serviceFeeLine(feeZar = SERVICE_FEE_ZAR) {
  return { code: SERVICE_FEE_LINE_CODE, label: SERVICE_FEE_LABEL, amount_zar: roundZar(feeZar) };
}

export function isServiceFeeLine(l) {
  return l?.code === SERVICE_FEE_LINE_CODE;
}

/** Service fee recorded on a payment (metadata field, falling back to a service_fee line). */
export function serviceFeeFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return 0;
  const direct = Number(meta.service_fee_zar);
  if (Number.isFinite(direct) && direct > 0) return roundZar(direct);
  const lines = Array.isArray(meta.lines) ? meta.lines : [];
  const feeLine = lines.find(isServiceFeeLine);
  return feeLine ? roundZar(feeLine.amount_zar) : 0;
}

/** Venue/host gross for a charge: Paystack amount minus the SEC service fee. */
export function netOfServiceFee(meta, chargedZar) {
  const charged = roundZar(chargedZar);
  const fee = serviceFeeFromMeta(meta);
  if (fee <= 0) return charged;
  return Math.max(0, roundZar(charged - fee));
}

/** Append the fee to checkout lines and return { lines, subtotal, serviceFee, total }. */
export function withServiceFee(chargeableLines, subtotalZar) {
  const subtotal = roundZar(subtotalZar);
  const serviceFee = serviceFeeForSubtotal(subtotal);
  const lines = serviceFee > 0 ? [...chargeableLines, serviceFeeLine(serviceFee)] : [...chargeableLines];
  return { lines, subtotal, serviceFee, total: roundZar(subtotal + serviceFee) };
}
