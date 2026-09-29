/**
 * Exact USD arithmetic for read-only reports.
 *
 * Recorded costs are DECIMAL(12, 6). Summing them as JavaScript floats accumulates binary
 * rounding error that the 12-digit report formatter would display, so report totals are
 * accumulated as integer picodollars (1e-12 USD) and converted to a Number only once.
 */
const SCALE = 12;
const PICO_PER_USD = 10n ** BigInt(SCALE);
const DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?(?:e([+-]?\d{1,3}))?$/i;

/** Integer division rounded half away from zero. */
export function divRoundPico(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Division by zero in USD report');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n * 2n + d) / (d * 2n);
  return negative ? -rounded : rounded;
}

/** Parse a recorded decimal amount exactly; digits beyond 1e-12 USD are rounded half away from zero. */
export function usdToPico(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid recorded USD amount');
  const match = DECIMAL_PATTERN.exec(typeof value === 'number' ? String(value) : value.trim());
  if (!match || (!match[2] && !match[3])) throw new Error('Invalid recorded USD amount');
  const [, sign, whole = '', fraction = '', exponent = '0'] = match;
  const digits = BigInt(`${whole}${fraction}` || '0');
  const shift = SCALE - fraction.length + Number(exponent);
  const magnitude = shift >= 0
    ? digits * 10n ** BigInt(shift)
    : divRoundPico(digits, 10n ** BigInt(-shift));
  return sign === '-' ? -magnitude : magnitude;
}

export function centsToPico(cents: number): bigint {
  return divRoundPico(usdToPico(cents), 100n);
}

export function sumUsdPico(values: Iterable<string | number | null | undefined>): bigint {
  let total = 0n;
  for (const value of values) total += usdToPico(value);
  return total;
}

/** Convert once, from the exact decimal string, to the nearest Number. */
export function picoToUsd(pico: bigint): number {
  const negative = pico < 0n;
  const magnitude = negative ? -pico : pico;
  const whole = magnitude / PICO_PER_USD;
  const fraction = (magnitude % PICO_PER_USD).toString().padStart(SCALE, '0');
  return Number(`${negative ? '-' : ''}${whole}.${fraction}`);
}
