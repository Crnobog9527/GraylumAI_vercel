/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * OpenRouter price snapshot per model (MODEL-PRICING-SYNC, plan
 * docs/launch/MODEL_PRICING_SYNC_PLAN.md section 3.1).
 *
 * Stored as `ai_models.config.pricing`, next to `config.reasoning`. It is
 * written only by reading the public OpenRouter catalog; no administrator
 * input can set a price. Browser and server share this file: schema,
 * normalization and labels. No database, network or Node imports.
 *
 * Units: token prices (`TOKEN_PRICE_KEYS`) are stored in USD per million
 * tokens, rounded up to 12 decimals. Every other price keeps OpenRouter's own
 * unit (for example `request` and `web_search` are USD per request). The
 * original strings stay in `raw` for audit.
 */
import { z } from "zod";

/** Prices OpenRouter quotes per token; stored per million tokens. */
export const TOKEN_PRICE_KEYS = [
  "prompt", "completion", "input_cache_read", "input_cache_write", "input_cache_write_1h", "internal_reasoning",
] as const;
/** Known prices that a text-only call does not use (plan D5 allowlist). Kept in OpenRouter's unit. */
export const NON_TEXT_PRICE_KEYS = [
  "request", "web_search", "image", "audio", "input_audio_cache", "image_output", "audio_output",
] as const;
export const PRICE_KEYS = [...TOKEN_PRICE_KEYS, ...NON_TEXT_PRICE_KEYS] as const;
export type PriceKey = (typeof PRICE_KEYS)[number];
/** The only condition keys an override may carry. */
export const CONDITION_KEYS = ["min_prompt_tokens", "utc_days", "utc_start", "utc_end"] as const;
export const UTC_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
/** Structure keys of the base pricing object; anything else there is recorded as unknown. */
const BASE_STRUCTURE_KEYS = ["discount", "overrides"] as const;

export const MAX_PRICED_ENDPOINTS = 64;
export const MAX_OVERRIDES = 16;
/** A raw pricing object larger than this is not stored and the route is not admissible. */
export const MAX_RAW_PRICING_BYTES = 4096;

/** Reasons a route cannot be priced; a route with any of them is not admissible. */
export const PRICING_ISSUES = {
  PRICING_MISSING: "目录没有给这条线路标价",
  BASE_PRICE_MISSING: "缺少输入或输出单价",
  PRICE_INVALID: "有价格不是非负的十进制数",
  OVERRIDE_INVALID: "分档或时段价格的格式无法识别",
  OVERRIDE_KEY_UNKNOWN: "分档或时段价格里有不认识的字段",
  OVERRIDE_CONDITION_MISSING: "分档或时段价格没有写条件",
  OVERRIDE_CONDITION_INVALID: "分档或时段价格的条件值不合法",
  TOO_MANY_OVERRIDES: `分档或时段价格超过 ${MAX_OVERRIDES} 条`,
  DISCOUNT_INVALID: "discount 不是数字",
  RAW_TOO_LARGE: "价格数据过大，没有保存",
  PRICE_NOT_UNIQUE: "同名线路出现了不同的价格",
} as const;
export type PricingIssue = keyof typeof PRICING_ISSUES;

const decimalText = z.string().regex(/^\d{1,9}(\.\d{1,12})?$/);
const priceShape = Object.fromEntries(PRICE_KEYS.map(key => [key, decimalText.optional()]));
const priceLayer = z.object(priceShape as Record<PriceKey, z.ZodOptional<typeof decimalText>>).strict();
export type PriceLayer = z.infer<typeof priceLayer>;
const hhmm = z.number().int().min(0).max(2359).refine(value => value % 100 <= 59);
const condition = z.object({
  minPromptTokens: z.number().int().positive().optional(),
  utcDays: z.array(z.enum(UTC_DAYS)).min(1).max(7).optional(),
  utcStart: hhmm.optional(),
  utcEnd: hhmm.optional(),
}).strict();
export type PriceCondition = z.infer<typeof condition>;
const pricedEndpoint = z.object({
  tag: z.string().min(1).max(128),
  contextLength: z.number().int().positive().nullable(),
  admissible: z.boolean(),
  issues: z.array(z.enum(Object.keys(PRICING_ISSUES) as [PricingIssue, ...PricingIssue[]])).max(16),
  base: priceLayer,
  overrides: z.array(z.object({ when: condition, prices: priceLayer }).strict()).max(MAX_OVERRIDES),
  discount: z.number().nullable(),
  unknownKeys: z.array(z.string().max(64)).max(32),
  raw: z.record(z.string().max(64), z.unknown()),
}).strict();
export type PricedEndpoint = z.infer<typeof pricedEndpoint>;

export const pricingSnapshot = z.object({
  fetchedAt: z.string().datetime(),
  model: z.string().min(1).max(256),
  source: z.string().min(1).max(512),
  pricingHash: z.string().regex(/^[0-9a-f]{64}$/),
  endpoints: z.array(pricedEndpoint).max(MAX_PRICED_ENDPOINTS),
}).strict();
export type PricingSnapshot = z.infer<typeof pricingSnapshot>;

/** The stored snapshot of one `ai_models.config` value, or null. Never throws. */
export function readPricingSnapshot(config: unknown): PricingSnapshot | null {
  const value = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).pricing : undefined;
  const parsed = pricingSnapshot.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const SCALE = 12;
/**
 * USD per token (OpenRouter's decimal string) to USD per million tokens,
 * rounded up to 12 decimals so a stored price is never below the catalog.
 * Returns null for anything that is not a plain non-negative decimal.
 */
export function perMillion(value: string): string | null {
  // At most 999 USD per token keeps the stored value within 9 integer digits.
  const match = /^(\d{1,3})(?:\.(\d{1,40}))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  // units of 1e-12 USD per million = value × 1e18; ceil over the dropped digits.
  const digits = BigInt(match[1]! + fraction), shift = 18 - fraction.length;
  const units = shift >= 0 ? digits * 10n ** BigInt(shift) : (digits + 10n ** BigInt(-shift) - 1n) / 10n ** BigInt(-shift);
  return formatUnits(units);
}
function formatUnits(units: bigint): string {
  const whole = units / 10n ** BigInt(SCALE), part = (units % 10n ** BigInt(SCALE)).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return part ? `${whole}.${part}` : whole.toString();
}
/** A non-token price as stored: the same decimal, at most 12 decimals, rounded up. */
function plainPrice(value: string): string | null {
  const match = /^(\d{1,9})(?:\.(\d{1,40}))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length <= SCALE) return formatUnits(BigInt(match[1]! + fraction.padEnd(SCALE, "0")));
  const drop = 10n ** BigInt(fraction.length - SCALE);
  return formatUnits((BigInt(match[1]! + fraction) + drop - 1n) / drop);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const TOKEN_KEYS = new Set<string>(TOKEN_PRICE_KEYS);
const ALL_PRICE_KEYS = new Set<string>(PRICE_KEYS);

function readLayer(source: Record<string, unknown>, keys: string[], issues: Set<PricingIssue>): PriceLayer {
  const layer: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    const normalized = typeof value === "string" ? (TOKEN_KEYS.has(key) ? perMillion(value) : plainPrice(value)) : null;
    if (normalized === null) issues.add("PRICE_INVALID");
    else layer[key] = normalized;
  }
  return layer as PriceLayer;
}

function readCondition(entry: Record<string, unknown>, issues: Set<PricingIssue>): PriceCondition {
  const when: PriceCondition = {};
  if ("min_prompt_tokens" in entry) when.minPromptTokens = entry.min_prompt_tokens as number;
  if ("utc_days" in entry) when.utcDays = entry.utc_days as PriceCondition["utcDays"];
  if ("utc_start" in entry) when.utcStart = entry.utc_start as number;
  if ("utc_end" in entry) when.utcEnd = entry.utc_end as number;
  if (!Object.keys(when).length) issues.add("OVERRIDE_CONDITION_MISSING");
  const parsed = condition.safeParse(when);
  if (!parsed.success) {
    issues.add("OVERRIDE_CONDITION_INVALID");
    return {};
  }
  return parsed.data;
}

function readOverrides(value: unknown, issues: Set<PricingIssue>): PricedEndpoint["overrides"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.add("OVERRIDE_INVALID");
    return [];
  }
  if (value.length > MAX_OVERRIDES) {
    issues.add("TOO_MANY_OVERRIDES");
    return [];
  }
  const overrides: PricedEndpoint["overrides"] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      issues.add("OVERRIDE_INVALID");
      continue;
    }
    const conditionKeys = CONDITION_KEYS as readonly string[];
    // An override mixes condition and price keys; one we cannot classify makes the route unpriceable.
    if (Object.keys(entry).some(key => !conditionKeys.includes(key) && !ALL_PRICE_KEYS.has(key))) issues.add("OVERRIDE_KEY_UNKNOWN");
    const prices = readLayer(entry, Object.keys(entry).filter(key => ALL_PRICE_KEYS.has(key)), issues);
    overrides.push({ when: readCondition(entry, issues), prices });
  }
  return overrides;
}

/**
 * Normalizes one endpoint's `pricing` object. Never throws: anything the
 * snapshot cannot represent is listed in `issues` and makes the route
 * not admissible, so one odd route never blocks reading the others.
 */
export function normalizeEndpointPricing(tag: string, contextLength: number | null, pricing: unknown): PricedEndpoint {
  const issues = new Set<PricingIssue>();
  const empty = { tag, contextLength, base: {}, overrides: [], discount: null, unknownKeys: [], raw: {} };
  if (!isRecord(pricing)) return { ...empty, admissible: false, issues: ["PRICING_MISSING"] };
  const raw = JSON.stringify(pricing);
  if (new TextEncoder().encode(raw).length > MAX_RAW_PRICING_BYTES) return { ...empty, admissible: false, issues: ["RAW_TOO_LARGE"] };
  const keys = Object.keys(pricing);
  const base = readLayer(pricing, keys.filter(key => ALL_PRICE_KEYS.has(key)), issues);
  if (base.prompt === undefined || base.completion === undefined) issues.add("BASE_PRICE_MISSING");
  const discount = pricing.discount === undefined || pricing.discount === null ? null : pricing.discount;
  if (discount !== null && (typeof discount !== "number" || !Number.isFinite(discount))) issues.add("DISCOUNT_INVALID");
  const structure = BASE_STRUCTURE_KEYS as readonly string[];
  const unknownKeys = keys.filter(key => !ALL_PRICE_KEYS.has(key) && !structure.includes(key))
    .sort().slice(0, 32).map(key => key.slice(0, 64));
  const overrides = readOverrides(pricing.overrides, issues);
  return {
    tag, contextLength, admissible: issues.size === 0, issues: [...issues], base, overrides,
    discount: typeof discount === "number" && Number.isFinite(discount) ? discount : null, unknownKeys,
    raw: JSON.parse(raw) as Record<string, unknown>,
  };
}

/** The price-relevant part of an endpoint, as a stable string; used to merge duplicate tags and to hash. */
export function priceIdentity(endpoint: Pick<PricedEndpoint, "base" | "overrides" | "discount" | "unknownKeys" | "issues">): string {
  const sortObject = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([
    sortObject(endpoint.base), endpoint.overrides.map(item => [sortObject(item.when), sortObject(item.prices)]),
    endpoint.discount, endpoint.unknownKeys, [...endpoint.issues].sort(),
  ]);
}

/**
 * One entry per tag. The catalog may list a tag twice: identical prices
 * merge and keep the smaller context length; different prices make the tag
 * not admissible ("price not unique").
 */
export function mergeDuplicateTags(endpoints: PricedEndpoint[]): PricedEndpoint[] {
  const merged = new Map<string, PricedEndpoint>();
  for (const endpoint of endpoints) {
    const seen = merged.get(endpoint.tag);
    if (!seen) {
      merged.set(endpoint.tag, endpoint);
      continue;
    }
    const contextLength = seen.contextLength === null ? endpoint.contextLength
      : endpoint.contextLength === null ? seen.contextLength : Math.min(seen.contextLength, endpoint.contextLength);
    if (priceIdentity(seen) === priceIdentity(endpoint)) merged.set(endpoint.tag, { ...seen, contextLength });
    else {
      const issues = [...new Set<PricingIssue>([...seen.issues, "PRICE_NOT_UNIQUE"])];
      merged.set(endpoint.tag, { ...seen, contextLength, admissible: false, issues });
    }
  }
  return [...merged.values()];
}

export type PriceChange = { tag: string; change: "added" | "removed" | "changed"; field?: string; before?: string; after?: string };

function flatten(endpoint: PricedEndpoint): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(endpoint.base)) fields.set(key, value as string);
  endpoint.overrides.forEach((item, index) => {
    for (const [key, value] of Object.entries(item.prices)) fields.set(`overrides[${index}].${key}`, value as string);
    fields.set(`overrides[${index}].when`, JSON.stringify(item.when));
  });
  fields.set("discount", String(endpoint.discount));
  fields.set("admissible", String(endpoint.admissible));
  return fields;
}

/** Field-level differences between two snapshots, for the refresh result and the change log. */
export function diffPricing(before: PricingSnapshot | null, after: PricingSnapshot): PriceChange[] {
  if (!before) return [];
  const changes: PriceChange[] = [];
  const old = new Map(before.endpoints.map(endpoint => [endpoint.tag, endpoint]));
  const next = new Map(after.endpoints.map(endpoint => [endpoint.tag, endpoint]));
  for (const tag of old.keys()) if (!next.has(tag)) changes.push({ tag, change: "removed" });
  for (const [tag, endpoint] of next) {
    const previous = old.get(tag);
    if (!previous) {
      changes.push({ tag, change: "added" });
      continue;
    }
    const a = flatten(previous), b = flatten(endpoint);
    for (const field of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(field) !== b.get(field)) changes.push({ tag, change: "changed", field, before: a.get(field), after: b.get(field) });
    }
  }
  return changes;
}

/** Administrator-facing names of each price. */
export const PRICE_LABELS: Record<PriceKey, string> = {
  prompt: "输入",
  completion: "输出",
  input_cache_read: "缓存读取",
  input_cache_write: "缓存写入（5 分钟）",
  input_cache_write_1h: "缓存写入（1 小时）",
  internal_reasoning: "思考",
  request: "每次请求",
  web_search: "联网搜索",
  image: "图片",
  audio: "音频",
  input_audio_cache: "音频缓存",
  image_output: "图片输出",
  audio_output: "音频输出",
};
/** Unit text shown after a stored price. */
export function priceUnit(key: PriceKey): string {
  if (TOKEN_KEYS.has(key)) return "美元 / 百万 token";
  if (key === "request" || key === "web_search") return "美元 / 次";
  return "美元（OpenRouter 原单位）";
}

const DAY_LABELS: Record<(typeof UTC_DAYS)[number], string> = {
  monday: "周一", tuesday: "周二", wednesday: "周三", thursday: "周四", friday: "周五", saturday: "周六", sunday: "周日",
};
const clock = (value: number) => `${String(Math.floor(value / 100)).padStart(2, "0")}:${String(value % 100).padStart(2, "0")}`;
/** Plain description of an override's condition, e.g. "输入 ≥ 272,000 token" or "周六、周日 UTC 14:00–00:00". */
export function describeCondition(when: PriceCondition): string {
  const parts: string[] = [];
  if (when.minPromptTokens !== undefined) parts.push(`输入 ≥ ${when.minPromptTokens.toLocaleString("en-US")} token`);
  if (when.utcDays) parts.push(when.utcDays.map(day => DAY_LABELS[day]).join("、"));
  if (when.utcStart !== undefined || when.utcEnd !== undefined) {
    const start = clock(when.utcStart ?? 0), end = clock(when.utcEnd ?? 0);
    parts.push(`UTC ${start}–${end}${(when.utcEnd ?? 0) <= (when.utcStart ?? 0) ? "（跨午夜）" : ""}`);
  }
  return parts.join("，") || "无条件";
}
