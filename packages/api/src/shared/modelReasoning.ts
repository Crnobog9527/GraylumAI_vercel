/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Administrator reasoning settings per model and purpose (MODEL-REASONING).
 *
 * Stored under `ai_models.config.reasoning`. Browser and server share this
 * file: schemas, validation and the request fragment each setting produces.
 * No database, network or Runtime imports.
 *
 * - `catalog` is a snapshot of OpenRouter's public model catalog for this
 *   model: its reasoning metadata and each provider route's parameters.
 * - `route` is the administrator's chosen provider route (the endpoint tag).
 *   Checks run against it, and a Runtime quote must use the same route.
 * - `purposes` holds one setting per purpose. `interactive` must be set for a
 *   model to serve interactive dialogue; an unset `organize` means the
 *   provider's default (no reasoning field is sent). `review` and `writing`
 *   are stored for later features and are not used by any call yet.
 */
import { z } from "zod";

/** Effort names documented by OpenRouter for `reasoning_effort` and `reasoning.effort`. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const REASONING_PURPOSES = ["interactive", "organize", "review", "writing"] as const;
export type ReasoningPurpose = (typeof REASONING_PURPOSES)[number];
export const PURPOSE_LABELS: Record<ReasoningPurpose, string> = {
  interactive: "交互对话",
  organize: "整理",
  review: "评审",
  writing: "写作",
};

/** Technical defaults (controller 2026-09-29), adjustable later:
 * a thinking budget must leave at least this many output tokens for the answer. */
export const MIN_ANSWER_TOKENS_AFTER_BUDGET = 1024;
/** Any enabled thinking (an effort other than none, or a budget) needs at least this output limit. */
export const MIN_MAX_TOKENS_WITH_THINKING = 4096;
/** Upper bound for a stored thinking budget. */
export const MAX_REASONING_BUDGET = 128000;

/** The model id pattern the Runtime already accepts; the catalog URL is built only from such an id. */
export const OPENROUTER_MODEL_ID = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

const effort = z.enum(REASONING_EFFORTS);
const wire = z.enum(["reasoning_effort", "reasoning"]);

export const catalogSnapshot = z
  .object({
    fetchedAt: z.string().datetime(),
    model: z.string().regex(OPENROUTER_MODEL_ID),
    /** Absent when the catalog lists no reasoning support for this model. */
    reasoning: z
      .object({
        mandatory: z.boolean(),
        defaultEnabled: z.boolean().nullable(),
        supportedEfforts: z.array(z.string().max(32)).max(16),
        defaultEffort: z.string().max(32).nullable(),
        supportsMaxTokens: z.boolean(),
      })
      .strict()
      .nullable(),
    endpoints: z
      .array(
        z
          .object({
            tag: z.string().min(1).max(128),
            providerName: z.string().max(128),
            supportedParameters: z.array(z.string().max(64)).max(64),
            contextLength: z.number().int().positive().nullable(),
            maxCompletionTokens: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type CatalogSnapshot = z.infer<typeof catalogSnapshot>;

/**
 * One purpose's setting.
 * - `provider_default`: send no reasoning field.
 * - `off`: disable thinking, through the route's supported field
 *   (`reasoning_effort: "none"` or `reasoning: {enabled: false}`).
 * - `effort`: one level the catalog lists, through either field.
 * - `budget`: a thinking token budget, only through the `reasoning` object.
 */
export const purposeSetting = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("provider_default") }).strict(),
  z.object({ mode: z.literal("off"), wire }).strict(),
  z.object({ mode: z.literal("effort"), effort, wire }).strict(),
  z.object({ mode: z.literal("budget"), maxTokens: z.number().int().positive().max(MAX_REASONING_BUDGET) }).strict(),
]);
export type PurposeSetting = z.infer<typeof purposeSetting>;

export const purposeSettings = z
  .object({
    interactive: purposeSetting.optional(),
    organize: purposeSetting.optional(),
    review: purposeSetting.optional(),
    writing: purposeSetting.optional(),
  })
  .strict();
export type PurposeSettings = z.infer<typeof purposeSettings>;

export const reasoningConfig = z
  .object({
    catalog: catalogSnapshot.nullable(),
    route: z.string().min(1).max(128).nullable(),
    purposes: purposeSettings,
  })
  .strict();
export type ReasoningConfig = z.infer<typeof reasoningConfig>;

export const EMPTY_REASONING_CONFIG: ReasoningConfig = { catalog: null, route: null, purposes: {} };

/** The stored config of one `ai_models.config` value, or the empty config. Never throws. */
export function readReasoningConfig(config: unknown): ReasoningConfig {
  const value = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).reasoning : undefined;
  const parsed = reasoningConfig.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_REASONING_CONFIG;
}

export type ReasoningIssue = { purpose: ReasoningPurpose | null; code: string; message: string };

/** Whether the route (an endpoint tag) supports a request parameter. */
export function routeSupports(catalog: CatalogSnapshot | null, route: string | null, parameter: string): boolean {
  return Boolean(catalog?.endpoints.find(endpoint => endpoint.tag === route)?.supportedParameters.includes(parameter));
}
/** Parameter forms the route supports. */
export function allowedWires(catalog: CatalogSnapshot | null, route: string | null): Array<"reasoning_effort" | "reasoning"> {
  return (["reasoning_effort", "reasoning"] as const).filter(wire => routeSupports(catalog, route, wire));
}
/** Modes a menu may offer for this catalog and route; the others would fail the checks. */
export function allowedModes(
  catalog: CatalogSnapshot | null,
  route: string | null,
  purpose: ReasoningPurpose,
): Array<PurposeSetting["mode"]> {
  const endpoint = catalog?.endpoints.find(item => item.tag === route);
  if (!endpoint || (purpose === "interactive" && !endpoint.supportedParameters.includes("tools"))) return [];
  const reasoning = catalog?.reasoning, modes: Array<PurposeSetting["mode"]> = ["provider_default"];
  const wire = allowedWires(catalog, route).length > 0;
  if (reasoning && wire && !reasoning.mandatory) modes.push("off");
  if (reasoning && wire && reasoning.supportedEfforts.length) modes.push("effort");
  if (reasoning?.supportsMaxTokens && routeSupports(catalog, route, "reasoning")) modes.push("budget");
  return modes;
}

/** Whether a setting enables thinking. */
export function thinkingEnabled(setting: PurposeSetting): boolean {
  return setting.mode === "budget" || (setting.mode === "effort" && setting.effort !== "none");
}

/**
 * Checks a config against its own catalog snapshot, the chosen route and the
 * model's output limit. Returns every problem with an administrator-readable
 * message; an empty list means the config can be saved.
 */
export function checkReasoningConfig(config: ReasoningConfig, model: { maxTokens: number; modelId: string }): ReasoningIssue[] {
  const issues: ReasoningIssue[] = [];
  const add = (purpose: ReasoningPurpose | null, code: string, message: string) => issues.push({ purpose, code, message });
  const configured = REASONING_PURPOSES.filter(purpose => config.purposes[purpose]);
  if (!configured.length && !config.route) return issues;
  const catalog = config.catalog;
  if (!catalog) {
    add(null, "CATALOG_REQUIRED", "请先读取 OpenRouter 模型目录");
    return issues;
  }
  if (catalog.model !== model.modelId) {
    add(null, "CATALOG_STALE", "模型 ID 已变化，目录快照属于旧的模型，请重新读取目录");
    return issues;
  }
  const endpoint = catalog.endpoints.find(item => item.tag === config.route);
  if (!config.route) add(null, "ROUTE_REQUIRED", "请选择供应商线路");
  else if (!endpoint) add(null, "ROUTE_UNKNOWN", "所选线路不在当前目录里，请重新读取目录后再选");
  if (config.purposes.interactive && endpoint && !endpoint.supportedParameters.includes("tools"))
    add("interactive", "ROUTE_TOOLS_UNSUPPORTED", "所选线路不支持工具调用，不能用于交互对话");
  for (const purpose of configured) {
    const setting = config.purposes[purpose]!;
    const label = PURPOSE_LABELS[purpose];
    if (setting.mode === "provider_default") continue;
    const reasoning = catalog.reasoning;
    if (!reasoning) {
      add(purpose, "REASONING_UNSUPPORTED", `目录显示这个模型不支持思考设置，"${label}"只能选"用供应商默认"`);
      continue;
    }
    const field = setting.mode === "budget" ? "reasoning" : setting.wire;
    if (endpoint && !endpoint.supportedParameters.includes(field))
      add(purpose, "ROUTE_PARAMETER_UNSUPPORTED", `所选线路不支持 ${field} 参数，"${label}"请换一种写法或换线路`);
    if (setting.mode === "off" && reasoning.mandatory)
      add(purpose, "THINKING_MANDATORY", `这个模型不能关闭思考，"${label}"请选择一个档位`);
    if (setting.mode === "effort" && setting.effort !== "none" && !reasoning.supportedEfforts.includes(setting.effort))
      add(purpose, "EFFORT_UNSUPPORTED", `目录没有列出"${setting.effort}"档位，"${label}"请从目录列出的档位中选择`);
    if (setting.mode === "effort" && setting.effort === "none" && reasoning.mandatory)
      add(purpose, "THINKING_MANDATORY", `这个模型不能关闭思考，"${label}"请选择一个档位`);
    if (setting.mode === "budget" && !reasoning.supportsMaxTokens)
      add(purpose, "BUDGET_UNSUPPORTED", `这个模型不支持思考预算，"${label}"请改用档位`);
    if (setting.mode === "budget" && setting.maxTokens + MIN_ANSWER_TOKENS_AFTER_BUDGET > model.maxTokens)
      add(purpose, "BUDGET_TOO_LARGE", `思考预算加上至少 ${MIN_ANSWER_TOKENS_AFTER_BUDGET} 个回答 token 超过了模型的输出上限（${model.maxTokens}）`);
    if (thinkingEnabled(setting) && model.maxTokens < MIN_MAX_TOKENS_WITH_THINKING)
      add(purpose, "OUTPUT_LIMIT_TOO_SMALL", `开启思考时，模型的输出上限至少要 ${MIN_MAX_TOKENS_WITH_THINKING}（现在是 ${model.maxTokens}）`);
  }
  return issues;
}

/** The request fields a setting adds. `provider_default` adds none. */
export function reasoningRequestFields(
  setting: PurposeSetting,
): Record<string, never> | { reasoning_effort: ReasoningEffort } | { reasoning: { enabled: false } | { effort: ReasoningEffort } | { max_tokens: number } } {
  switch (setting.mode) {
    case "provider_default":
      return {};
    case "off":
      return setting.wire === "reasoning_effort" ? { reasoning_effort: "none" } : { reasoning: { enabled: false } };
    case "effort":
      return setting.wire === "reasoning_effort" ? { reasoning_effort: setting.effort } : { reasoning: { effort: setting.effort } };
    case "budget":
      return { reasoning: { max_tokens: setting.maxTokens } };
  }
}
