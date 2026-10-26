/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CHARGE_CONFIRM_TEXT, createChargeGate, ReportChargeView } from "./report-charge-confirm";

const noop = () => {};
const view = (fields: Record<string, unknown>) => renderToStaticMarkup(
  <ReportChargeView asking={false} retry={false} price={500} disabled={false} onAsk={noop} onCancel={noop} onConfirm={noop} {...fields} />);

it("the offer button only asks: first generation and 重新生成 both show the price and no confirmation yet", () => {
  expect(view({})).toContain("生成完整报告（500 积分）");
  expect(view({ retry: true })).toContain("重新生成（500 积分）");
  expect(view({ retry: true })).not.toContain("确认并扣");
});
it("the confirmation names the fixed price, never an estimate, for every entry", () => {
  for (const retry of [false, true]) {
    const html = view({ asking: true, retry });
    expect(html).toContain("确认后将扣除 500 积分");
    expect(html).toContain("确认并扣 500 积分");
    expect(html).toContain(CHARGE_CONFIRM_TEXT.cancel);
    expect(html).not.toContain("预计");
  }
});
it("no readable price, no confirmation and no paid start", () => {
  expect(view({ asking: true, price: null })).not.toContain("确认并扣");
});
it("a double click on 确认 starts once; cancelling starts nothing; asking again re-arms", () => {
  const gate = createChargeGate();
  expect(gate.confirm()).toBe(false);
  gate.ask();
  expect(gate.confirm()).toBe(true);
  expect(gate.confirm()).toBe(false);
  gate.ask();
  gate.cancel();
  expect(gate.confirm()).toBe(false);
  gate.ask();
  expect(gate.confirm()).toBe(true);
});
// The only way into start/restart in the report dialog is through the confirmation (B1, 2026-10-26).
it("the report dialog never wires the offer button straight to start or restart", () => {
  const panel = readFileSync(new URL("./report-panel.tsx", import.meta.url), "utf8");
  expect(panel).toContain("<ReportChargeAction");
  expect(panel).not.toMatch(/onClick=\{[^}]*report\.(start|restart)/);
});
