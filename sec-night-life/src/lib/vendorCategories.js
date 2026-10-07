export const VENDOR_CATEGORIES = [
  { value: 'food_snacks', label: 'Food & snacks' },
  { value: 'equipment_rental', label: 'Equipment rental' },
  { value: 'dj_av', label: 'DJ / AV' },
  { value: 'decor', label: 'Decor' },
  { value: 'photography', label: 'Photography' },
  { value: 'other', label: 'Other' },
];

export const VENDOR_PRICE_UNITS = [
  { value: 'per_event', label: 'per event' },
  { value: 'per_hour', label: 'per hour' },
  { value: 'per_day', label: 'per day' },
  { value: 'per_person', label: 'per person' },
  { value: 'per_item', label: 'per item' },
];

export const VENDOR_INQUIRY_STATUS_LABELS = {
  REQUESTED: 'Requested',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export function vendorCategoryLabel(value) {
  return VENDOR_CATEGORIES.find((c) => c.value === value)?.label || value || 'Service';
}

export function vendorPriceUnitLabel(value) {
  return VENDOR_PRICE_UNITS.find((u) => u.value === value)?.label || '';
}

/**
 * "From R1 500 per event" / "Quote on request" / null.
 * @param {{ price_from_zar?: number|null, price_unit?: string|null, quote_on_request?: boolean }} vendor
 * @param {(zar: number) => string} formatMoney
 */
export function vendorPriceText(vendor, formatMoney) {
  if (!vendor) return null;
  const amount = Number(vendor.price_from_zar);
  if (Number.isFinite(amount) && amount > 0) {
    const unit = vendorPriceUnitLabel(vendor.price_unit);
    return `From ${formatMoney(amount)}${unit ? ` ${unit}` : ''}`;
  }
  if (vendor.quote_on_request) return 'Quote on request';
  return null;
}
