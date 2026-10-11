/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ available: undefined as unknown }));
vi.mock("@/trpc/client", () => ({ trpc: { runtime: { reportAvailable: { useQuery: () => ({ data: state.available }) } } } }));
import { PublishFootnote, PublishNext, REPORT_FLOW_TEXT, ReportFlowNotice, reportPublishes } from "./report-publish";

beforeEach(() => { state.available = { enabled: true }; });

it("uses 报告→定稿 only for a flow that declares report generation", () => {
  expect(reportPublishes({ reportGeneration: true })).toBe(true);
  expect(reportPublishes({ reportGeneration: false })).toBe(false);
  expect(reportPublishes({})).toBe(false);
  expect(reportPublishes(undefined)).toBe(false);
});

it("tells the user how the report becomes official, without predicted credits", () => {
  for (const text of Object.values(REPORT_FLOW_TEXT)) {
    expect(text).toContain("定稿");
    expect(text).not.toMatch(/积分|计费|扣费/);
  }
});

it("points at 生成完整报告 only while the server switch shows that entry", () => {
  expect(renderToStaticMarkup(<ReportFlowNotice kind="next" />)).toBe(REPORT_FLOW_TEXT.next);
  expect(renderToStaticMarkup(<ReportFlowNotice kind="footnote" />)).toBe(REPORT_FLOW_TEXT.footnote);
  for (const off of [{ enabled: false }, undefined]) {
    state.available = off;
    const text = renderToStaticMarkup(<ReportFlowNotice kind="next" />);
    expect(text).toBe(REPORT_FLOW_TEXT.unavailable);
    expect(text).not.toContain("生成完整报告」");
  }
});

it("keeps the old footer wording for a flow without a report", () => {
  expect(renderToStaticMarkup(<PublishFootnote workflow={{ reportGeneration: false }} />)).toBe("确认后保存为正式定位；生成选题将在下一步单独确认。");
  expect(renderToStaticMarkup(<PublishFootnote workflow={{ reportGeneration: true }} />)).toBe(REPORT_FLOW_TEXT.footnote);
});

it("keeps the old next-step wording for a flow without a report", () => {
  expect(renderToStaticMarkup(<PublishNext workflow={{ reportGeneration: false }} />)).toContain("下一步是确认正式定位");
  expect(renderToStaticMarkup(<PublishNext workflow={{ reportGeneration: true }} />)).toBe(REPORT_FLOW_TEXT.next);
});
