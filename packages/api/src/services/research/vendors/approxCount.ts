/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE: YouTube only publishes subscriber counts rounded to three significant figures, and TikHub's
// detail route returns just that label ("1.88万位订阅者", "15.1M subscribers"; checked against real responses on
// 2026-10-23). Owner 2026-10-23: "YouTube 对标按约数保守判断，同意 A" — a YouTube count is read as an approximate
// number, and a benchmark threshold is met only when every exact count the label could stand for meets it.
// Every other platform keeps exact counts only.

const UNITS: Record<string, bigint> = { k: 1_000n, m: 1_000_000n, b: 1_000_000_000n, '万': 10_000n, '亿': 100_000_000n };
const LABEL = /^\s*(\d{1,4})(?:\.(\d{1,3}))?\s*([KMB万亿])?\s*(?:subscribers?|位订阅者|订阅者)?\s*$/i;

/** The number a YouTube subscriber label shows; undefined for anything else (never a guess). */
export function approximateSubscribers(label: unknown): number | undefined {
  if (typeof label !== 'string') return undefined;
  const match = label.match(LABEL);
  if (!match) return undefined;
  const [, whole, fraction = '', unitText] = match;
  if (fraction && !unitText) return undefined;
  const unit = unitText ? UNITS[unitText.toLowerCase()] ?? UNITS[unitText]! : 1n;
  // Exact decimal arithmetic: "1.88万" is 18800, not 18799.999…
  const scaled = BigInt(whole! + fraction) * unit / 10n ** BigInt(fraction.length);
  const value = Number(scaled);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The exact counts `[low, highExclusive)` a shown approximate count may stand for. Three significant figures, read
 * conservatively: half a step below (in case it was rounded) to a full step above (in case it was cut). Below 1000
 * YouTube shows the exact count.
 */
export function approximateRange(value: number): { low: number; highExclusive: number } {
  if (!Number.isSafeInteger(value) || value < 1000) return { low: value, highExclusive: value + 1 };
  const step = 10 ** (String(value).length - 3);
  return { low: value - step / 2, highExclusive: value + step };
}
