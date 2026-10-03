/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
const price = z.string().regex(/^\d{1,9}(\.\d{1,12})?$/);
const prices = { prompt: price, completion: price, internalReasoning: price.optional(), request: price,
  cacheRead: price.optional(), cacheWrite: price.optional() };
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nominalPricing = z.object({
  version: z.literal('nominal-v1'),
  pricingHash: z.string().regex(/^[0-9a-f]{64}$/),
  endpointTag: z.string().min(1).max(128),
  tiers: z.array(z.object({ minPromptTokens: tokenCount, ...prices }).strict()).min(1).max(17),
  timeOfDay: z.array(z.object({ minPromptTokens: tokenCount.positive().optional(), ...prices }).strict()).max(16),
}).strict().refine(value => value.tiers[0]!.minPromptTokens === 0
  && value.tiers.length + value.timeOfDay.length <= 17
  && value.tiers.every((tier, i) => i === 0 || tier.minPromptTokens > value.tiers[i - 1]!.minPromptTokens),
{ message: 'BILL2_NOMINAL_TIERS_INVALID' });
export type NominalPricing = z.infer<typeof nominalPricing>;
type Prices = Omit<NominalPricing['tiers'][number], 'minPromptTokens'>;
const unit = 1_000_000_000_000n;
function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * unit + BigInt(fraction.padEnd(12, '0'));
}
function format(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  value = value < 0n ? -value : value;
  const denominator = 10n ** BigInt(scale);
  const fraction = (value % denominator).toString().padStart(scale, '0').replace(/0+$/, '');
  return `${sign}${value / denominator}${fraction ? `.${fraction}` : ''}`;
}
/** Time layers are base-inherited; never inherit the selected token tier. */
export function selectNominalPrices(value: NominalPricing, promptTokens: number): Prices {
  const table = nominalPricing.parse(value);
  tokenCount.parse(promptTokens);
  const tier = table.tiers.filter(item => item.minPromptTokens <= promptTokens).at(-1)!;
  const layers = [tier, ...table.timeOfDay.filter(item => (item.minPromptTokens ?? 0) <= promptTokens)];
  const highest = (field: 'prompt' | 'completion' | 'request' | 'internalReasoning') => format(
    layers.reduce((highest, layer) => {
      const amount = units(field === 'internalReasoning' ? layer.internalReasoning ?? layer.completion : layer[field]);
      return amount > highest ? amount : highest;
    }, 0n), 12);
  const cache = (field: 'cacheRead' | 'cacheWrite') => {
    // Missing prices stay unknown; do not invent a free cache rate for a possible time layer.
    if (layers.some(layer => layer[field] === undefined)) return {};
    const amount = layers.reduce((max, layer) => units(layer[field]!) > max ? units(layer[field]!) : max, 0n);
    return { [field]: format(amount, 12) };
  };
  return { prompt: highest('prompt'), completion: highest('completion'),
    internalReasoning: highest('internalReasoning'), request: highest('request'),
    ...cache('cacheRead'), ...cache('cacheWrite') };
}
/** Only tiers reachable by T participate; retain unreachable tiers for P > T settlement. */
export function validateNominalBound(value: NominalPricing, bound: {
  pricingHash: string; endpointTag: string; promptTokensUpper: number;
  promptUsdPerMillion: string; completionUsdPerMillion: string; requestUsd: string;
}): void {
  const table = nominalPricing.parse(value);
  tokenCount.parse(bound.promptTokensUpper);
  if (table.pricingHash !== bound.pricingHash || table.endpointTag !== bound.endpointTag) {
    throw new Error('BILL2_NOMINAL_IDENTITY_CONFLICT');
  }
  [bound.promptUsdPerMillion, bound.completionUsdPerMillion, bound.requestUsd].forEach(value => price.parse(value));
  for (const layer of [...table.tiers, ...table.timeOfDay]) {
    if ((layer.minPromptTokens ?? 0) > bound.promptTokensUpper) continue;
    if (units(layer.prompt) > units(bound.promptUsdPerMillion)
      || units(layer.completion) > units(bound.completionUsdPerMillion)
      || units(layer.internalReasoning ?? layer.completion) > units(bound.completionUsdPerMillion)
      || units(layer.request) > units(bound.requestUsd)) throw new Error('BILL2_NOMINAL_BOUND_CONFLICT');
  }
}
export type NominalUsage = { promptTokens?: number; completionTokens?: number; reasoningTokens?: number };
/** Missing data is distinct from contradictions; caller controls bounded lookup/fallback. */
export function nominalCost(value: NominalPricing, usage: NominalUsage): string | null {
  nominalPricing.parse(value);
  for (const count of [usage.promptTokens, usage.completionTokens, usage.reasoningTokens]) {
    if (count !== undefined && !tokenCount.safeParse(count).success) throw new Error('BILL2_TOKEN_EVIDENCE_CONFLICT');
  }
  if (usage.reasoningTokens !== undefined && usage.completionTokens !== undefined
    && usage.reasoningTokens > usage.completionTokens) throw new Error('BILL2_TOKEN_EVIDENCE_CONFLICT');
  if (usage.promptTokens === undefined || usage.completionTokens === undefined) return null;
  const selected = selectNominalPrices(value, usage.promptTokens);
  const completion = units(selected.completion), reasoning = units(selected.internalReasoning ?? selected.completion);
  if (reasoning !== completion && usage.reasoningTokens === undefined) return null;
  const r = BigInt(usage.reasoningTokens ?? 0);
  return format(BigInt(usage.promptTokens) * units(selected.prompt)
    + (BigInt(usage.completionTokens) - r) * completion + r * reasoning
    + units(selected.request) * 1_000_000n, 18);
}
/** Call only after bounded lookup is exhausted; no credit rounding or float arithmetic here. */
export function nominalActualFallback(actualUsd: string, upperUsd: string): string {
  const decimal = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,12})?$/);
  decimal.parse(actualUsd);
  decimal.parse(upperUsd);
  return format(units(actualUsd) < units(upperUsd) ? units(actualUsd) : units(upperUsd), 12);
}


export type NominalCostBreakdown = {
  platformDifferenceUsd: string;
  cacheReadSavingsUsd: string | null;
  cacheWritePremiumUsd: string | null;
  otherDifferenceUsd: string | null;
};
/** Audit only: g = read savings - write premium + other. Never used to charge the user.
 * Time cache prices follow the frozen maximum convention; actual time/discount differences
 * stay in other. Missing or contradictory audit fields never become a made-up zero. */
export function nominalCostBreakdown(
  table: NominalPricing,
  usage: { promptTokens?: number; cachedTokens?: number; cacheCreationTokens?: number },
  nominalUsd: string,
  actualUsd: string,
  nominalSource: 'nominal' | 'actual_fallback' = 'nominal',
): NominalCostBreakdown {
  nominalPricing.parse(table);
  const amount = (value: string) => {
    z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,18})?$/).parse(value);
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  };
  const difference = amount(nominalUsd) - amount(actualUsd);
  const result: NominalCostBreakdown = { platformDifferenceUsd: format(difference, 18),
    cacheReadSavingsUsd: null, cacheWritePremiumUsd: null, otherDifferenceUsd: null };
  if (nominalSource === 'actual_fallback' || usage.promptTokens === undefined
    || !tokenCount.safeParse(usage.promptTokens).success) return result;
  const selected = selectNominalPrices(table, usage.promptTokens);
  const valid = (count: number | undefined) => count !== undefined && tokenCount.safeParse(count).success
    && count <= usage.promptTokens!;
  const readValid = valid(usage.cachedTokens), writeValid = valid(usage.cacheCreationTokens);
  if (readValid && writeValid && usage.cachedTokens! + usage.cacheCreationTokens! > usage.promptTokens) return result;
  const read = readValid && selected.cacheRead !== undefined
    ? BigInt(usage.cachedTokens!) * (units(selected.prompt) - units(selected.cacheRead)) : null;
  const write = writeValid && selected.cacheWrite !== undefined
    ? BigInt(usage.cacheCreationTokens!) * (units(selected.cacheWrite) - units(selected.prompt)) : null;
  return { platformDifferenceUsd: result.platformDifferenceUsd,
    cacheReadSavingsUsd: read === null ? null : format(read, 18),
    cacheWritePremiumUsd: write === null ? null : format(write, 18),
    otherDifferenceUsd: read === null || write === null ? null : format(difference - read + write, 18) };
}
