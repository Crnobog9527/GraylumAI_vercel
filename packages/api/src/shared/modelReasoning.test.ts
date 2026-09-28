/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  EMPTY_REASONING_CONFIG,
  MIN_ANSWER_TOKENS_AFTER_BUDGET,
  MIN_MAX_TOKENS_WITH_THINKING,
  checkReasoningConfig,
  purposeSetting,
  readReasoningConfig,
  reasoningRequestFields,
  type CatalogSnapshot,
  type ReasoningConfig,
} from "./modelReasoning";

const catalog = (patch: Partial<CatalogSnapshot> = {}): CatalogSnapshot => ({
  fetchedAt: "2026-09-29T00:00:00.000Z",
  model: "deepseek/deepseek-v4.1-flash",
  reasoning: { mandatory: false, defaultEnabled: true, supportedEfforts: ["max", "high", "low"], defaultEffort: "high", supportsMaxTokens: false },
  endpoints: [
    { tag: "deepinfra", providerName: "DeepInfra", supportedParameters: ["tools", "reasoning", "reasoning_effort"], contextLength: 1000000, maxCompletionTokens: 64000 },
    { tag: "alibaba", providerName: "Alibaba", supportedParameters: ["tools", "reasoning"], contextLength: 1000000, maxCompletionTokens: 64000 },
    { tag: "notools", providerName: "No tools", supportedParameters: ["reasoning_effort"], contextLength: 1000000, maxCompletionTokens: 64000 },
  ],
  ...patch,
});
const model = { maxTokens: 8192, modelId: "deepseek/deepseek-v4.1-flash" };
const config = (patch: Partial<ReasoningConfig>): ReasoningConfig => ({ catalog: catalog(), route: "deepinfra", purposes: {}, ...patch });
const codes = (value: ReasoningConfig, limits = model) => checkReasoningConfig(value, limits).map(issue => issue.code);

describe("checkReasoningConfig", () => {
  it("accepts the DeepSeek mentor setting: interactive thinking off through reasoning_effort", () => {
    expect(codes(config({ purposes: { interactive: { mode: "off", wire: "reasoning_effort" } } }))).toEqual([]);
  });

  it("accepts an empty config and a provider default for every purpose", () => {
    expect(codes(EMPTY_REASONING_CONFIG)).toEqual([]);
    const all = { mode: "provider_default" } as const;
    expect(codes(config({ purposes: { interactive: all, organize: all, review: all, writing: all } }))).toEqual([]);
  });

  it.each([
    ["no catalog", config({ catalog: null, purposes: { organize: { mode: "provider_default" } } }), ["CATALOG_REQUIRED"]],
    ["a catalog of another model", config({ catalog: catalog({ model: "qwen/qwen3.8-flash" }), purposes: { organize: { mode: "provider_default" } } }), ["CATALOG_STALE"]],
    ["no route", config({ route: null, purposes: { organize: { mode: "provider_default" } } }), ["ROUTE_REQUIRED"]],
    ["an unknown route", config({ route: "gone", purposes: { organize: { mode: "provider_default" } } }), ["ROUTE_UNKNOWN"]],
    ["interactive on a route without tools", config({ route: "notools", purposes: { interactive: { mode: "off", wire: "reasoning_effort" } } }), ["ROUTE_TOOLS_UNSUPPORTED"]],
    ["reasoning_effort on a route without it", config({ route: "alibaba", purposes: { organize: { mode: "off", wire: "reasoning_effort" } } }), ["ROUTE_PARAMETER_UNSUPPORTED"]],
    ["an effort the catalog does not list", config({ purposes: { organize: { mode: "effort", effort: "medium", wire: "reasoning_effort" } } }), ["EFFORT_UNSUPPORTED"]],
    ["a budget on a model without budgets", config({ purposes: { organize: { mode: "budget", maxTokens: 1000 } } }), ["BUDGET_UNSUPPORTED"]],
  ])("reports %s", (_name, value, expected) => {
    expect(codes(value)).toEqual(expected);
  });

  it("refuses to disable thinking where the catalog marks it mandatory", () => {
    const mandatory = catalog({ reasoning: { ...catalog().reasoning!, mandatory: true } });
    expect(codes(config({ catalog: mandatory, purposes: { interactive: { mode: "off", wire: "reasoning" } } }))).toEqual(["THINKING_MANDATORY"]);
    expect(codes(config({ catalog: mandatory, purposes: { interactive: { mode: "effort", effort: "none", wire: "reasoning_effort" } } })))
      .toEqual(["THINKING_MANDATORY"]);
  });

  it("offers only the provider default when the catalog lists no reasoning", () => {
    expect(codes(config({ catalog: catalog({ reasoning: null }), purposes: { organize: { mode: "off", wire: "reasoning" } } }))).toEqual(["REASONING_UNSUPPORTED"]);
  });

  it("ties budgets and enabled thinking to the output limit", () => {
    const budgets = catalog({ reasoning: { ...catalog().reasoning!, supportsMaxTokens: true } });
    const budget = (maxTokens: number) => config({ catalog: budgets, route: "alibaba", purposes: { organize: { mode: "budget", maxTokens } } });
    expect(codes(budget(8192 - MIN_ANSWER_TOKENS_AFTER_BUDGET))).toEqual([]);
    expect(codes(budget(8192 - MIN_ANSWER_TOKENS_AFTER_BUDGET + 1))).toEqual(["BUDGET_TOO_LARGE"]);
    const high = config({ purposes: { organize: { mode: "effort", effort: "high", wire: "reasoning_effort" } } });
    expect(codes(high, { ...model, maxTokens: MIN_MAX_TOKENS_WITH_THINKING })).toEqual([]);
    expect(codes(high, { ...model, maxTokens: MIN_MAX_TOKENS_WITH_THINKING - 1 })).toEqual(["OUTPUT_LIMIT_TOO_SMALL"]);
    // Disabling thinking has no output-limit requirement.
    expect(codes(config({ purposes: { interactive: { mode: "off", wire: "reasoning_effort" } } }), { ...model, maxTokens: 1000 })).toEqual([]);
  });
});

describe("purpose settings and request fields", () => {
  it.each([
    [{ mode: "provider_default" }, {}],
    [{ mode: "off", wire: "reasoning_effort" }, { reasoning_effort: "none" }],
    [{ mode: "off", wire: "reasoning" }, { reasoning: { enabled: false } }],
    [{ mode: "effort", effort: "low", wire: "reasoning_effort" }, { reasoning_effort: "low" }],
    [{ mode: "effort", effort: "max", wire: "reasoning" }, { reasoning: { effort: "max" } }],
    [{ mode: "budget", maxTokens: 256 }, { reasoning: { max_tokens: 256 } }],
  ] as const)("maps %j to %j", (setting, fields) => {
    expect(reasoningRequestFields(purposeSetting.parse(setting))).toEqual(fields);
  });

  it.each([
    { mode: "off" },
    { mode: "effort", effort: "extreme", wire: "reasoning_effort" },
    { mode: "budget", maxTokens: 0 },
    { mode: "budget", maxTokens: 256, wire: "reasoning" },
    { mode: "on" },
  ])("rejects the malformed setting %j", setting => {
    expect(purposeSetting.safeParse(setting).success).toBe(false);
  });

  it("reads a stored config tolerantly and never throws", () => {
    const stored = config({ purposes: { interactive: { mode: "off", wire: "reasoning_effort" } } });
    expect(readReasoningConfig({ connection_status: "connected", reasoning: stored })).toEqual(stored);
    for (const value of [null, undefined, "x", [], {}, { reasoning: { route: 1 } }]) expect(readReasoningConfig(value)).toEqual(EMPTY_REASONING_CONFIG);
  });
});
