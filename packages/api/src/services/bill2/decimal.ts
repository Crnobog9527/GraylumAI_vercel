/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
const SCALE = 1_000_000_000_000n;
export function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/.test(value)) {
    throw new Error('BILL2_INVALID_DECIMAL');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
export function aggregateCredits(costs: readonly string[], creditsPerUsd: string, multiplier: string): number {
  const rate = decimal(creditsPerUsd), margin = decimal(multiplier);
  if (rate === 0n || margin === 0n) throw new Error('BILL2_INVALID_RULES');
  const numerator = costs.reduce((sum, cost) => sum + decimal(cost), 0n) * rate * margin;
  const denominator = SCALE ** 3n;
  const result = (numerator + denominator - 1n) / denominator;
  if (result > 2_147_483_647n) throw new Error('BILL2_CREDITS_OVERFLOW');
  return Number(result);
}

/** JSON number lexemes never pass through a JS Number, including nested costs.
 * Duplicate keys are rejected instead of silently accepting last-write-wins evidence. */
export function parseExactJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > 65_536) throw new Error('BILL2_EVIDENCE_TOO_LARGE');
  let at = 0;
  const fail = (): never => { throw new Error('BILL2_INVALID_JSON'); };
  const ws = () => { while (/[ \t\r\n]/.test(raw[at] ?? '') && at < raw.length) at++; };
  const string = (): string => {
    const start = at++;
    for (; at < raw.length; at++) {
      if (raw[at] === '\\') { at++; continue; }
      if (raw[at] === '"') { at++; return JSON.parse(raw.slice(start, at)) as string; }
    }
    return fail();
  };
  const value = (depth = 0): unknown => {
    if (depth > 32) return fail();
    ws();
    if (raw[at] === '"') return string();
    if (raw[at] === '{') {
      at++; ws(); const result: Record<string, unknown> = Object.create(null);
      if (raw[at] === '}') { at++; return result; }
      for (;;) {
        ws(); if (raw[at] !== '"') return fail(); const key = string();
        if (Object.hasOwn(result, key)) return fail(); ws(); if (raw[at++] !== ':') return fail();
        result[key] = value(depth + 1); ws(); const separator = raw[at++];
        if (separator === '}') return result; if (separator !== ',') return fail();
      }
    }
    if (raw[at] === '[') {
      at++; ws(); const result: unknown[] = [];
      if (raw[at] === ']') { at++; return result; }
      for (;;) { result.push(value(depth + 1)); ws(); const separator = raw[at++];
        if (separator === ']') return result; if (separator !== ',') return fail(); }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(literal, at)) { at += literal.length; return parsed; }
    }
    const token = raw.slice(at).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!token) return fail(); at += token[0].length; return token[0];
  };
  const result = value(); ws(); if (at !== raw.length) return fail(); return result;
}
