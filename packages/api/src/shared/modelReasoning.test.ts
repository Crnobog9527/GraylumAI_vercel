/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  EMPTY_REASONING_CONFIG,
  REASONING_PURPOSES,
  allowedModes,
  allowedWires,
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

  it("uses the full endpoint tag as the route, exactly as a quote's providerSlug writes it", () => {
    // Staging quotes name one endpoint, e.g. deepseek on deepinfra/fp8 (#475, STG-CONFIG).
    const variants = catalog({ endpoints: [
      { tag: "deepinfra/fp8", providerName: "DeepInfra", supportedParameters: ["tools", "reasoning_effort"], contextLength: 1, maxCompletionTokens: 1 },
      { tag: "deepinfra/bf16", providerName: "DeepInfra", supportedParameters: ["tools"], contextLength: 1, maxCompletionTokens: 1 },
    ] });
    const off = { interactive: { mode: "off", wire: "reasoning_effort" } } as const;
    const quote = { providerSlug: "deepinfra/fp8" };
    const value = config({ catalog: variants, route: quote.providerSlug, purposes: off });
    expect(codes(value)).toEqual([]);
    expect(value.route === quote.providerSlug).toBe(true);
    // Checks read only the chosen endpoint; another variant of the same provider is its own route.
    expect(codes(config({ catalog: variants, route: "deepinfra/bf16", purposes: off }))).toEqual(["ROUTE_PARAMETER_UNSUPPORTED"]);
    // A base provider name is not an endpoint tag.
    expect(codes(config({ catalog: variants, route: "deepinfra", purposes: off }))).toEqual(["ROUTE_UNKNOWN"]);
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

describe("menu choices", () => {
  const sample = (mode: string, wire: "reasoning_effort" | "reasoning", effort: string) =>
    mode === "off" ? { mode, wire } : mode === "effort" ? { mode, effort, wire } : mode === "budget" ? { mode, maxTokens: 1000 } : { mode };
  it.each([
    ["the DeepSeek route", catalog(), "deepinfra", ["provider_default", "off", "effort"], ["reasoning_effort", "reasoning"]],
    ["a route with only the reasoning object", catalog(), "alibaba", ["provider_default", "off", "effort"], ["reasoning"]],
    ["no reasoning in the catalog", catalog({ reasoning: null }), "deepinfra", ["provider_default"], ["reasoning_effort", "reasoning"]],
    ["mandatory thinking with budgets", catalog({ reasoning: { ...catalog().reasoning!, mandatory: true, supportsMaxTokens: true } }), "alibaba",
      ["provider_default", "effort", "budget"], ["reasoning"]],
    ["a route without tools", catalog(), "notools", ["provider_default", "off", "effort"], ["reasoning_effort"]],
    ["no route yet", catalog(), null, [], []],
    ["no catalog yet", null, null, [], []],
  ] as const)("every offered choice passes the checks for every purpose on %s", (_name, snapshot, route, modes, wires) => {
    expect(allowedWires(snapshot, route)).toEqual(wires);
    for (const purpose of REASONING_PURPOSES) {
      const expected = purpose === "interactive" && route === "notools" ? [] : modes;
      expect(allowedModes(snapshot, route, purpose)).toEqual(expected);
      // The dialog always also offers unset, including before selecting a route.
      expect(codes(config({ catalog: snapshot, route, purposes: {} }))).toEqual([]);
      for (const mode of allowedModes(snapshot, route, purpose)) {
        for (const wire of wires.length ? wires : ["reasoning"] as const) {
          for (const effort of snapshot?.reasoning?.supportedEfforts.length ? snapshot.reasoning.supportedEfforts : ["low"]) {
            const setting = purposeSetting.parse(sample(mode, wire, effort));
            expect(codes(config({ catalog: snapshot, route, purposes: { [purpose]: setting } }))).toEqual([]);
          }
        }
      }
    }
  });

  it("offers no configured modes for a route removed from the catalog", () => {
    for (const purpose of REASONING_PURPOSES) {
      expect(allowedModes(catalog(), "removed", purpose)).toEqual([]);
    }
  });
});

describe("selected endpoint output limits", () => {
  const limited = (maxCompletionTokens: number | null, setting: unknown) => config({
    catalog: catalog({
      reasoning: { ...catalog().reasoning!, supportsMaxTokens: true },
      endpoints: catalog().endpoints.map(endpoint => endpoint.tag === "deepinfra"
        ? { ...endpoint, maxCompletionTokens } : endpoint),
    }),
    purposes: { organize: purposeSetting.parse(setting) },
  });

  it("rejects a budget above the route cap and identifies the limiting source", () => {
    const issues = checkReasoningConfig(limited(2000, { mode: "budget", maxTokens: 1000 }), model);
    expect(issues.map(issue => issue.code)).toEqual(["BUDGET_TOO_LARGE", "OUTPUT_LIMIT_TOO_SMALL"]);
    for (const issue of issues) {
      expect(issue.message).toContain("所选线路的输出上限");
      expect(issue.message).toContain("2000");
    }
  });

  it("rejects enabled thinking below the route minimum but permits disabled thinking", () => {
    expect(codes(limited(4095, { mode: "effort", effort: "low", wire: "reasoning" }))).toEqual(["OUTPUT_LIMIT_TOO_SMALL"]);
    expect(codes(limited(4096, { mode: "effort", effort: "low", wire: "reasoning" }))).toEqual([]);
    expect(codes(limited(2000, { mode: "off", wire: "reasoning" }))).toEqual([]);
  });

  it("accepts the exact route budget boundary and rejects one extra token", () => {
    expect(codes(limited(4096, { mode: "budget", maxTokens: 4096 - MIN_ANSWER_TOKENS_AFTER_BUDGET }))).toEqual([]);
    expect(codes(limited(4096, { mode: "budget", maxTokens: 4096 - MIN_ANSWER_TOKENS_AFTER_BUDGET + 1 })))
      .toEqual(["BUDGET_TOO_LARGE"]);
  });

  it.each([null, 16000])("keeps the model limit when the route cap is %s", cap => {
    expect(codes(limited(cap, { mode: "budget", maxTokens: model.maxTokens - MIN_ANSWER_TOKENS_AFTER_BUDGET }))).toEqual([]);
    const issues = checkReasoningConfig(limited(cap, { mode: "budget", maxTokens: model.maxTokens }), model);
    expect(issues.map(issue => issue.code)).toEqual(["BUDGET_TOO_LARGE"]);
    expect(issues[0].message).toContain("模型的输出上限");
    expect(issues[0].message).toContain(String(model.maxTokens));
  });
});
