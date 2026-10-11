/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import { REPORT_FLOW_TEXT, reportPublishes } from "./report-publish";

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
