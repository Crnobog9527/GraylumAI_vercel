/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * The one derivation from a price snapshot to the prices a call is frozen with
 * (MODEL-PRICING-SYNC PR B; plan docs/launch/MODEL_PRICING_SYNC_PLAN.md 3.3).
 *
 * Single-field form: the frozen `promptUsdPerMillion` / `completionUsdPerMillion`
 * / `requestUsd` are the highest prices any applicable layer can charge, so the
 * BILL2 upper bound and OpenRouter `max_price` both use them unchanged.
 * Browser and server share this file; no database, network or Node imports.
 */
import type { PriceLayer, PricedEndpoint } from "./modelPricing";

const SCALE = 12;
const UNIT = 10n ** BigInt(SCALE);
function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * UNIT + BigInt(fraction.padEnd(SCALE, "0"));
}
function text(value: bigint): string {
  const whole = value / UNIT, part = (value % UNIT).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return part ? `${whole}.${part}` : whole.toString();
}
const max = (values: bigint[]) => values.reduce((a, b) => (b > a ? b : a), 0n);

export type FrozenPrices = {
  promptUsdPerMillion: string;
  completionUsdPerMillion: string;
  requestUsd: string;
  /** Total price of one cache-written token (#572), present when the route charges for cache writes. */
  cacheWriteUsdPerMillion?: string;
  /** Plain explanation of where each frozen price comes from, for the administrator page. */
  explain: { prompt: string; completion: string };
};
export type DeriveRefusal = "NOT_ADMISSIBLE" | "UNKNOWN_PRICE_FIELD";

/**
 * Whether a route's `input_cache_write` is a fee added to the input price
 * (Gemini's storage fee) rather than the total price of a written token
 * (Anthropic, OpenAI, Qwen). Google routes are additive; on any other route a
 * write price below the input price is also treated as additive, which can
 * only overstate the bound. (A total price would never be below the input.)
 */
export function cacheWriteIsAdditive(model: string, prompt: bigint, write: bigint): boolean {
  return model.startsWith("google/") || write < prompt;
}

type Layer = { label: string; price: (key: keyof PriceLayer) => bigint | null };

/** The base layer plus every override that can apply to a call of up to `promptTokensUpper` input tokens.
 * Time-of-day overrides always apply (a call may cross a boundary; plan D7). Missing override prices inherit the base. */
function applicableLayers(endpoint: PricedEndpoint, promptTokensUpper: number): Layer[] {
  const read = (layer: PriceLayer, key: keyof PriceLayer) => (layer[key] === undefined ? null : units(layer[key]!));
  const layers: Layer[] = [{ label: "基础价", price: key => read(endpoint.base, key) }];
  endpoint.overrides.forEach((override, index) => {
    if (override.when.minPromptTokens !== undefined && promptTokensUpper < override.when.minPromptTokens) return;
    layers.push({ label: `第 ${index + 1} 档`, price: key => read(override.prices, key) ?? read(endpoint.base, key) });
  });
  return layers;
}

/**
 * Derives the frozen prices of one route. `promptTokensUpper` is the most input
 * tokens the call may send: today the whole provider context; with BILL-PAYG,
 * the per-call T. A route that is not admissible, or whose base prices carry a
 * field this version does not know (plan D5), is refused.
 */
export function deriveFrozenPrices(model: string, endpoint: PricedEndpoint, promptTokensUpper: number): FrozenPrices | DeriveRefusal {
  if (!endpoint.admissible) return "NOT_ADMISSIBLE";
  if (endpoint.unknownKeys.length) return "UNKNOWN_PRICE_FIELD";
  const prompts: Array<[bigint, string]> = [], completions: Array<[bigint, string]> = [], requests: bigint[] = [], writes: bigint[] = [];
  for (const layer of applicableLayers(endpoint, promptTokensUpper)) {
    const prompt = layer.price("prompt"), completion = layer.price("completion");
    if (prompt === null || completion === null) return "NOT_ADMISSIBLE";
    const write = layer.price("input_cache_write");
    const written = write === null ? null : cacheWriteIsAdditive(model, prompt, write) ? prompt + write : write;
    if (written !== null) writes.push(written);
    prompts.push(written !== null && written > prompt ? [written, `${layer.label}缓存写入`] : [prompt, `${layer.label}输入`]);
    const reasoning = layer.price("internal_reasoning");
    completions.push(reasoning !== null && reasoning > completion ? [reasoning, `${layer.label}思考`] : [completion, `${layer.label}输出`]);
    requests.push(layer.price("request") ?? 0n);
  }
  const pick = (items: Array<[bigint, string]>) => items.reduce((a, b) => (b[0] > a[0] ? b : a));
  const prompt = pick(prompts), completion = pick(completions);
  return {
    promptUsdPerMillion: text(prompt[0]),
    completionUsdPerMillion: text(completion[0]),
    requestUsd: text(max(requests)),
    ...(writes.length ? { cacheWriteUsdPerMillion: text(max(writes)) } : {}),
    explain: { prompt: prompt[1], completion: completion[1] },
  };
}

export type PriceComparison = { field: "prompt" | "completion" | "request"; frozen: string; current: string };

/** Fields where a frozen quote is below the current derivation (a price rise). Empty means the quote still covers it. */
export function priceIncreases(
  frozen: { promptUsdPerMillion: string; completionUsdPerMillion: string; requestUsd: string },
  current: FrozenPrices,
): PriceComparison[] {
  const pairs: PriceComparison[] = [
    { field: "prompt", frozen: frozen.promptUsdPerMillion, current: current.promptUsdPerMillion },
    { field: "completion", frozen: frozen.completionUsdPerMillion, current: current.completionUsdPerMillion },
    { field: "request", frozen: frozen.requestUsd, current: current.requestUsd },
  ];
  return pairs.filter(pair => units(pair.frozen) < units(pair.current));
}
