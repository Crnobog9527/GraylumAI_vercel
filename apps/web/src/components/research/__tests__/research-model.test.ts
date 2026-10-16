/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  cellSourceNumbers, cellText, formatCount, formatFrequency, formatLastUpdate, formatRate, numberSources,
} from "../benchmark-table-model";
import { DATA_SOURCE_NOTE, describeCall, MISSING_TEXT } from "../research-model";
import {
  buildCandidateSubmission, buildKeywordSubmission, cardErrorText, initialKeywordDraft, keywordProblem,
} from "../selection-card-model";
import { formatEvidenceTime, publicLink } from "../evidence-list";
import { describeRequest } from "../research-model";
import { refreshErrorText } from "../refresh-button";
import { chargeText } from "../search-charges";
import { toEvidenceEntries, toSearchCharges } from "../research-api";
import { CALLS, CANDIDATE_CARD, CHARGES, FOLLOW_UP_CARD, KEYWORD_CARD, NOW, ROWS } from "./fixtures";

describe("describeCall", () => {
  const views = CALLS.map(describeCall);

  it("maps the four stream states to 成功 / 未取到 / 待核 and 正在搜", () => {
    expect(views.map(view => view.state)).toEqual(["success", "success", "pending", "missing", "running"]);
  });

  it("says what was searched and which kind of data, without suppliers, routes or costs", () => {
    expect(views[0]).toMatchObject({ query: "小红书 职场穿搭 博主 2026", line: "网页搜索", detail: null });
    expect(views[1]).toMatchObject({ line: "抖音 · 关键词作品" });
    expect(views[2]).toMatchObject({ line: "抖音 · 近期作品", detail: "这次没有拿到确定结果，正在核对。" });
    expect(views[3]).toMatchObject({ line: "B 站 · 粉丝数", detail: "这次没有取到数据。" });
    const shown = JSON.stringify(views);
    for (const word of ["tikhub", "parallel", "firecrawl", "TikHub", "Parallel", "Firecrawl", "美元", "积分", "$"]) {
      expect(shown).not.toContain(word);
    }
  });

  it("uses the Owner-approved source sentence", () => {
    expect(DATA_SOURCE_NOTE).toBe("AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。");
  });
});

describe("keyword card submission", () => {
  it("sends picks only, edits only when changed, additions last", () => {
    const draft = { ...initialKeywordDraft(KEYWORD_CARD), selected: ["k1", "k3"], additions: [" 西装外套 "],
      texts: { k1: "职场穿搭", k2: "通勤穿搭", k3: "胶囊衣橱 搭配" } };
    expect(buildKeywordSubmission(KEYWORD_CARD, draft)).toEqual({ ok: true,
      submission: { selected: ["k1", "k3"], edits: { k3: "胶囊衣橱 搭配" }, additions: ["西装外套"] } });
  });

  it("refuses an empty, over-long, duplicate or over-limit list", () => {
    const base = initialKeywordDraft(KEYWORD_CARD);
    expect(buildKeywordSubmission(KEYWORD_CARD, { ...base, selected: [] })).toMatchObject({ ok: false });
    expect(buildKeywordSubmission(KEYWORD_CARD, { ...base, texts: { ...base.texts, k1: "长".repeat(41) } }))
      .toEqual({ ok: false, problem: "每个关键词最多 40 个字" });
    expect(buildKeywordSubmission(KEYWORD_CARD, { ...base, additions: ["职场穿搭"] })).toEqual({ ok: false, problem: "关键词有重复" });
    expect(buildKeywordSubmission(KEYWORD_CARD, { ...base, additions: ["a", "b", "c"] })).toEqual({ ok: false, problem: "最多 5 个关键词" });
    expect(keywordProblem("  ")).toBe("关键词不能为空");
  });
});

describe("candidate card submission", () => {
  it("needs at least the host minimum and never sends head references", () => {
    expect(buildCandidateSubmission(CANDIDATE_CARD, ["c1", "c2"])).toEqual({ ok: false, problem: "至少选 3 个" });
    expect(buildCandidateSubmission(CANDIDATE_CARD, ["c1", "c2", "h1"])).toEqual({ ok: false, problem: "至少选 3 个" });
    expect(buildCandidateSubmission(CANDIDATE_CARD, ["c3", "c1", "c2", "h1"])).toEqual({ ok: true, submission: { selected: ["c1", "c2", "c3"] } });
    expect(buildCandidateSubmission(CANDIDATE_CARD, ["c1", "c2", "c3", "c4", "c5", "c6"])).toEqual({ ok: false, problem: "最多选 5 个" });
  });

  it("follows the follow-up card's own minimum", () => {
    expect(buildCandidateSubmission(FOLLOW_UP_CARD, ["c6"])).toEqual({ ok: true, submission: { selected: ["c6"] } });
  });

  it("maps host error codes to plain sentences", () => {
    expect(cardErrorText("RESEARCH_CARD_ALREADY_CONFIRMED")).toBe("这张卡已经确认过了，不能再改。");
    expect(cardErrorText("SOMETHING_ELSE")).toBe("确认没有成功，请稍后再试。");
  });
});

describe("benchmark table", () => {
  it("formats numbers and shows missing values as missing, never 0", () => {
    expect([formatCount(9800), formatCount(38200), formatCount(126000), formatCount(2_350_000), formatCount(3.4e8)])
      .toEqual(["9,800", "3.8 万", "12.6 万", "235 万", "3.4 亿"]);
    expect([formatRate(0.0634), formatRate(0.112), formatFrequency(4.2), formatFrequency(2)]).toEqual(["6.34%", "11.2%", "每周 4.2 条", "每周 2 条"]);
    expect([formatCount(null), formatRate(null), formatFrequency(null), formatLastUpdate(null, NOW)]).toEqual(Array(4).fill(MISSING_TEXT));
    expect(formatCount(0)).toBe("0");
    expect(formatLastUpdate("2026-10-13T10:00:00Z", NOW)).toBe("2026-10-13（1 天前）");
    expect(cellText(ROWS[1]!, "medianViews", NOW)).toBe(MISSING_TEXT);
  });

  it("numbers sources by evidence record in reading order; a missing cell cites nothing", () => {
    const { entries, numberOf } = numberSources(ROWS);
    expect(entries.slice(0, 3).map(entry => entry.evidenceId)).toEqual(["ev1", "ev2", "ev3"]);
    expect(cellSourceNumbers(ROWS[0]!, "medianViews", numberOf)).toEqual([2]);
    expect(cellSourceNumbers(ROWS[1]!, "medianViews", numberOf)).toEqual([]);
    expect(cellSourceNumbers(ROWS[1]!, "lastPublishedAt", numberOf)).toEqual([4]);
  });
});

describe("search charges and evidence", () => {
  it("shows an amount only for a paid search and says free otherwise", () => {
    expect(CHARGES.map(chargeText)).toEqual(["0.3 积分", "1 积分", "没取到数据，不收费", "结果待核，不收费", "不收费（这次没有拿到用量记录）"]);
  });

  it("links only plain public http(s) sources", () => {
    expect(publicLink("https://www.douyin.com/user/a")).toBe("https://www.douyin.com/user/a");
    expect(publicLink("javascript:alert(1)")).toBeNull();
    expect(publicLink("https://user:pw@example.com/")).toBeNull();
  });

  it("maps refresh errors to plain sentences", () => {
    expect(refreshErrorText(new Error("RESEARCH_REFRESH_INVALID"))).toBe("这个账号现在不能刷新，可能正在读取中，请稍后再试。");
    expect(refreshErrorText(new Error("boom"))).toBe("刷新没有成功，请稍后再试。");
  });
});

describe("server rows from research.toolCharges and research.evidence", () => {
  it("keeps attributed tool calls, passes settlement through and marks unsettled ones", () => {
    const charges = toSearchCharges([
      { callId: "a", toolName: "web_search", args: { query: "q" }, source: "tool_usage", credits: "0.25" },
      { callId: "b", toolName: null, args: null, source: "tool_usage", credits: "1" },
      { callId: "c", toolName: "web_fetch", args: null, source: null, credits: null },
    ]);
    expect(charges.map(charge => charge.callId)).toEqual(["a", "c"]);
    expect(charges.map(chargeText)).toEqual(["0.25 积分", "结算中"]);
  });

  it("maps evidence rows without inventing a route or a title", () => {
    const [entry, ...rest] = toEvidenceEntries([
      { operationId: "o1", toolName: "social_account", args: { platform: "douyin", account: "a" }, state: "succeeded",
        fetchedAt: "2026-10-16T00:00:00Z", itemCount: 3, truncated: null, sources: ["https://x.test/a"],
        sessionId: "s1", sessionTitle: null },
      { operationId: "o2", toolName: null, args: null, state: "failed", fetchedAt: null, itemCount: null, truncated: null,
        sources: [], sessionId: "s1", sessionTitle: "t" },
    ]);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ evidenceId: "o1", truncated: false, conversationTitle: "未命名对话", sourceUrls: ["https://x.test/a"] });
    expect(entry).not.toHaveProperty("conversationHref");
  });
});

describe("review round 2", () => {
  it("shows evidence times in the viewer's time zone", () => {
    expect(formatEvidenceTime("2026-10-16T18:00:00Z", "Asia/Shanghai")).toBe("2026-10-17 02:00");
    expect(formatEvidenceTime("2026-10-16T18:00:00Z", "America/New_York")).toBe("2026-10-16 14:00");
    expect(formatEvidenceTime(null)).toBe("—");
  });

  it("does not repeat every selected account on each billed fetch", () => {
    const accounts = [{ platform: "douyin", account: "a" }, { platform: "douyin", account: "b" }];
    expect(describeRequest("benchmark_fetch", { accounts })?.query).toBe("选中的对标账号（共 2 个）");
    expect(describeRequest("benchmark_fetch", { accounts: accounts.slice(0, 1) })?.query).toBe("a");
  });
});
