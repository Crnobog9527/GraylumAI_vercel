/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import type { SanitizedReportData } from "@repo/api/src/shared/reportData";
import { reportExportMarkdown } from "./report-export";

const body = [
  "## 一、结论（约 800 字）", "先做同城手冲咖啡。", "", "| 平台 | 角色 |", "| --- | --- |", "| 抖音 | 主平台 |",
  "## 二、对标账号分析", "看 <b>三个</b> 账号 ![img](https://example.com/a.png)", "",
  "```graylum-report-data", '{"summary":"raw block"}', "```",
].join("\n");
const strategy: { data: SanitizedReportData; textEdited: string[] } = {
  data: { v: 1, dropped: [], fallback: {}, data: {
    benchmarks: { accounts: [{ platform: "抖音", account: "咖啡_店", category: "同城", takeaway: "学开头",
      metrics: { followers: 12345, medianViews: null, engagementRate: 0.052, weeklyPosts: 3, capturedAt: null } }] },
  } } as unknown as SanitizedReportData,
  textEdited: ["benchmarks"],
};

describe("reportExportMarkdown", () => {
  it("keeps the report's chapters and tables as Markdown, without the writing hints or the raw data block", () => {
    const text = reportExportMarkdown({ body });
    expect(text.startsWith("# 完整运营策略报告\n")).toBe(true);
    expect(text).toContain("## 一、结论\n");
    expect(text).not.toContain("800 字");
    expect(text).toContain("| 抖音 | 主平台 |");
    expect(text).toContain("## 二、对标账号分析");
    expect(text).not.toContain("graylum-report-data");
    expect(text).not.toContain("raw block");
    expect(text).not.toContain("策略要点");
  });
  it("neutralizes raw HTML and images in the text", () => {
    const text = reportExportMarkdown({ body });
    expect(text).toContain("&lt;b&gt;三个&lt;/b&gt;");
    expect(text).not.toContain("<b>");
    expect(text).not.toContain("![img]");
  });
  it("adds the strategy data as 策略要点 with the host's benchmark numbers, null as 没查到, edits noted", () => {
    const text = reportExportMarkdown({ body, strategy });
    expect(text).toContain("## 策略要点");
    expect(text).toContain("### 对标账号数据");
    expect(text).toContain("| 咖啡\\_店 | 抖音 | 1.2万 | 没查到 | 5.2% | 3 次 |".replace("1.2万", new Intl.NumberFormat("zh-CN",
      { maximumFractionDigits: 1 }).format(12345)));
    expect(text).toContain("报告文字被手动改过");
  });
  it("says the notes once under the title", () => {
    const text = reportExportMarkdown({ body, notes: ["这份报告的结构不完整，不能作为正式报告。"] });
    expect(text).toContain("\n\n> 这份报告的结构不完整，不能作为正式报告。\n\n");
  });
});
