/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FALLBACK_RULE_TEXT, ReportBenchmarkGate, type ReportPreflight } from "./report-benchmark-gate";

const gate = (value: ReportPreflight) => renderToStaticMarkup(
  <ReportBenchmarkGate value={value} failed={false} busy={false} onRetry={vi.fn()} onChoose={vi.fn(async () => undefined)} />);
const card = { choice: null, required: 3 } as unknown as NonNullable<ReportPreflight["card"]>;

describe("the report's benchmark gate says the fallback rule as it is (round 13)", () => {
  it("states both conditions: one qualified benchmark and two rounds that returned data", () => {
    expect(FALLBACK_RULE_TEXT).toContain("至少有 1 个合格对标");
    expect(FALLBACK_RULE_TEXT).toContain("两轮");
    expect(FALLBACK_RULE_TEXT).toContain("没取到数据的不算");
  });
  it("round 13: one counted round and no qualified benchmark shows the rule and the real counts, not a choice card", () => {
    const html = gate({ canGenerate: false, qualified: 0, required: 3, rounds: 1, card });
    expect(html).toContain("至少有 1 个合格对标");
    expect(html).toContain("已找过 1 轮、0 个合格");
    expect(html).not.toContain("用现有对标先生成</button>");
  });
  it("two rounds but no qualified benchmark: still no card (the rule needs both)", () => {
    expect(gate({ canGenerate: false, qualified: 0, required: 3, rounds: 2, card })).toContain("已找过 2 轮、0 个合格");
  });
});
