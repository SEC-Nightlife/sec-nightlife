/** Format a rand amount, e.g. 1500 → "R1 500" (en-ZA grouping), 99.5 → "R99.50". */
export function formatZar(n) {
  const v = Number(n) || 0;
  const hasCents = Math.round(v * 100) % 100 !== 0;
  return `R${v.toLocaleString('en-ZA', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
