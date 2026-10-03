/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** PAYG projections are financial evidence, never instructions to charge the wallet. */
export type PaygReportFields = {
  contract_version?: string | number;
  settled_at?: string | null;
  nominal_cost_usd?: string | null;
  nominal_source?: string | null;
  charged_delta?: number | string | null;
  compensation_credits?: number | string | null;
  compensated_at?: string | null;
  theoretical_delta?: number | string | null;
  platform_absorbed_cap_credits?: number | string | null;
  platform_absorbed_bound_credits?: number | string | null;
  platform_absorbed_cap_usd?: string | null;
  platform_absorbed_bound_usd?: string | null;
  platform_margin_cache_read_usd?: string | null;
  platform_margin_cache_write_usd?: string | null;
  platform_margin_other_usd?: string | null;
};
type Row = PaygReportFields & {
  call_id: string; provider: string; model: string; purpose: string | null;
  selected_cost_usd: string | number | null;
  credits_per_usd: string | number; call_multiplier: string | null;
};
const SCALE = 10n ** 18n;
const amount = (value: string | number | null | undefined): bigint => {
  if (value === null || value === undefined) throw new Error('Missing evidence');
  const match = /^(-?)(\d+)(?:\.(\d{1,18}))?$/.exec(String(value));
  if (!match) throw new Error('Invalid evidence');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]!) * SCALE + BigInt((match[3] ?? '').padEnd(18, '0')));
};
const text = (n: bigint): string => {
  const abs = n < 0n ? -n : n;
  const tail = (abs % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${abs / SCALE}${tail ? `.${tail}` : ''}`;
};
const credits = (value: number | string | null | undefined): number => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value))) {
    throw new Error('Invalid credits');
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid credits');
  return n;
};
export const isPaygContract = (version: PaygReportFields['contract_version']): boolean =>
  version === 'bill2.v2' || version === 'v2' || version === '2' || version === 2;
type Rational = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
function add(a: Rational, b: Rational): Rational {
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  const factor = gcd(n, d);
  return { n: n / factor, d: d / factor };
}
function equivalent(credits: number, row: Row): Rational {
  const rate = amount(row.credits_per_usd) * amount(row.call_multiplier);
  if (rate <= 0n) throw new Error('Invalid frozen rate');
  return { n: BigInt(credits) * SCALE * SCALE, d: rate };
}
function displayEquivalent(value: Rational) {
  const scale = 10n ** 12n;
  const rounded = (value.n * scale * 2n + value.d) / (2n * value.d);
  return `${rounded / scale}.${(rounded % scale).toString().padStart(12, '0')}`;
}
function project(row: Row) {
  const c = amount(row.selected_cost_usd);
  const n = amount(row.nominal_cost_usd);
  if (c < 0n || n < 0n || !row.settled_at || !Number.isFinite(Date.parse(row.settled_at))) throw new Error('Invalid settlement');
  const charged = credits(row.charged_delta);
  const compensation = credits(row.compensation_credits ?? 0);
  if (compensation > charged || (row.compensated_at && !Number.isFinite(Date.parse(row.compensated_at)))
    || (compensation > 0 && !row.compensated_at)) throw new Error('Invalid compensation');
  const theoretical = credits(row.theoretical_delta);
  const cap = credits(row.platform_absorbed_cap_credits);
  const bound = credits(row.platform_absorbed_bound_credits);
  if (charged + cap + bound !== theoretical) throw new Error('Credit conservation failed');
  if (row.nominal_source !== 'nominal' && row.nominal_source !== 'actual_fallback') throw new Error('Unknown nominal source');
  const capEquivalent = equivalent(cap, row);
  const boundEquivalent = equivalent(bound, row);
  const fallback = row.nominal_source === 'actual_fallback';
  const pieces = [row.platform_margin_cache_read_usd, row.platform_margin_cache_write_usd, row.platform_margin_other_usd];
  const split = !fallback && pieces.every(v => v !== null && v !== undefined) ? pieces.map(amount) : null;
  // The write-premium column is signed: a cost increase is a negative margin component.
  if (split && split.reduce((sum, v) => sum + v, 0n) !== n - c) throw new Error('Margin conservation failed');
  return { callId: row.call_id, provider: row.provider, model: row.model, purpose: row.purpose ?? 'unknown',
    utcDate: new Date(row.settled_at).toISOString().slice(0, 10), nominalSource: row.nominal_source,
    officialCostUsd: text(c), nominalCostUsd: text(n), platformMarginUsd: text(n - c),
    chargedCredits: charged, compensationCredits: compensation, netChargedCredits: charged - compensation,
    compensatedAt: row.compensated_at ?? null, theoreticalCredits: theoretical, capCredits: cap, boundCredits: bound,
    capApplied: cap > 0, cacheReadMarginUsd: split ? text(split[0]!) : null,
    cacheWriteMarginUsd: split ? text(split[1]!) : null, otherMarginUsd: split ? text(split[2]!) : null,
    marginBreakdownAvailable: Boolean(split),
    capNominalEquivalentUsd: displayEquivalent(capEquivalent),
    boundNominalEquivalentUsd: displayEquivalent(boundEquivalent),
  };
}
export function buildPaygReport(rows: readonly Row[]) {
  const calls: ReturnType<typeof project>[] = [];
  let unsettledCalls = 0;
  let releasedUnsentCalls = 0;
  const releasedFailureCalls: Array<{
    callId: string; provider: string; model: string; officialCostUsd: string | null; providerCostKnown: boolean;
    nominalCostUsd: string; chargedCredits: number; netChargedCredits: number;
  }> = [];
  let invalidCalls = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isPaygContract(row.contract_version)) continue;
    if (seen.has(row.call_id)) { invalidCalls += 1; continue; }
    seen.add(row.call_id);
    if (row.nominal_source === 'not_dispatched' || row.nominal_source === 'confirmed_failure') {
      try {
        const failed = row.nominal_source === 'confirmed_failure';
        const cost = row.selected_cost_usd === null ? null : amount(row.selected_cost_usd);
        if (amount(row.nominal_cost_usd) !== 0n || (!failed && cost !== 0n) || (cost !== null && cost < 0n)
          || credits(row.compensation_credits ?? 0) !== 0
          || credits(row.charged_delta) !== 0 || credits(row.theoretical_delta) !== 0
          || credits(row.platform_absorbed_cap_credits) !== 0 || credits(row.platform_absorbed_bound_credits) !== 0) {
          throw new Error('Invalid unsent evidence');
        }
        if (failed) releasedFailureCalls.push({ callId: row.call_id, provider: row.provider, model: row.model,
          officialCostUsd: cost === null ? null : text(cost), providerCostKnown: cost !== null,
          nominalCostUsd: '0', chargedCredits: 0, netChargedCredits: 0 });
        else releasedUnsentCalls += 1;
      } catch { invalidCalls += 1; }
      continue;
    }
    if (!row.settled_at) { unsettledCalls += 1; continue; }
    try { calls.push(project(row)); } catch { invalidCalls += 1; }
  }
  const rowMap = new Map<string, Row>();
  for (const row of rows) if (!rowMap.has(row.call_id)) rowMap.set(row.call_id, row);
  const groups = new Map<string, {
    provider: string; model: string; purpose: string; utcDate: string; calls: number; cappedCalls: number;
    actualFallbackCalls: number; chargedCredits: number; theoreticalCredits: number; capCredits: number; boundCredits: number;
    compensationCredits: number; netChargedCredits: number;
    c: bigint; n: bigint; fallbackMargin: bigint; nominalMargin: bigint;
    capEquivalent: Rational; boundEquivalent: Rational;
    readMargin: bigint; writeMargin: bigint; otherMargin: bigint; missingBreakdownCalls: number;
  }>();
  for (const call of calls) {
    const key = JSON.stringify([call.provider, call.model, call.purpose, call.utcDate]);
    const group = groups.get(key) ?? { provider: call.provider, model: call.model, purpose: call.purpose, utcDate: call.utcDate,
      calls: 0, cappedCalls: 0, actualFallbackCalls: 0, chargedCredits: 0, theoreticalCredits: 0, capCredits: 0, boundCredits: 0,
      compensationCredits: 0, netChargedCredits: 0,
      c: 0n, n: 0n, fallbackMargin: 0n, nominalMargin: 0n,
      capEquivalent: { n: 0n, d: 1n }, boundEquivalent: { n: 0n, d: 1n },
      readMargin: 0n, writeMargin: 0n, otherMargin: 0n, missingBreakdownCalls: 0 };
    group.capEquivalent = add(group.capEquivalent, equivalent(call.capCredits, rowMap.get(call.callId)!));
    group.boundEquivalent = add(group.boundEquivalent, equivalent(call.boundCredits, rowMap.get(call.callId)!));
    group.calls += 1;
    group.cappedCalls += Number(call.capApplied);
    group.actualFallbackCalls += Number(call.nominalSource === 'actual_fallback');
    for (const field of ['chargedCredits', 'compensationCredits', 'netChargedCredits',
      'theoreticalCredits', 'capCredits', 'boundCredits'] as const) group[field] += call[field];
    group.c += amount(call.officialCostUsd);
    group.n += amount(call.nominalCostUsd);
    if (call.nominalSource === 'actual_fallback') group.fallbackMargin += amount(call.platformMarginUsd);
    else {
      group.nominalMargin += amount(call.platformMarginUsd);
      if (call.marginBreakdownAvailable) {
        group.readMargin += amount(call.cacheReadMarginUsd);
        group.writeMargin += amount(call.cacheWriteMarginUsd);
        group.otherMargin += amount(call.otherMarginUsd);
      } else group.missingBreakdownCalls += 1;
    }
    groups.set(key, group);
  }
  return { calls, unsettledCalls, releasedUnsentCalls, releasedFailureCalls, invalidCalls, complete: invalidCalls === 0,
    groups: [...groups.values()].map(({
      c, n, fallbackMargin, nominalMargin, capEquivalent, boundEquivalent, readMargin, writeMargin, otherMargin, ...group
    }) => ({ ...group,
      officialCostUsd: text(c), nominalCostUsd: text(n), platformMarginUsd: text(n - c),
      actualFallbackMarginUsd: text(fallbackMargin), nominalMarginUsd: text(nominalMargin),
      capNominalEquivalentUsd: displayEquivalent(capEquivalent), boundNominalEquivalentUsd: displayEquivalent(boundEquivalent),
      cacheReadMarginUsd: group.missingBreakdownCalls ? null : text(readMargin),
      cacheWriteMarginUsd: group.missingBreakdownCalls ? null : text(writeMargin),
      otherMarginUsd: group.missingBreakdownCalls ? null : text(otherMargin),
      nominalEquivalentDisplayDecimals: 12, capRatio: group.calls ? group.cappedCalls / group.calls : 0 })),
    refundedCredits: invalidCalls ? null : calls.reduce((sum, call) => sum + call.compensationCredits, 0),
    netChargedCredits: invalidCalls ? null : calls.reduce((sum, call) => sum + call.netChargedCredits, 0),
    platformAbsorbedCredits: invalidCalls ? null : calls.reduce((sum, c) => sum + c.capCredits + c.boundCredits, 0),
  };
}
