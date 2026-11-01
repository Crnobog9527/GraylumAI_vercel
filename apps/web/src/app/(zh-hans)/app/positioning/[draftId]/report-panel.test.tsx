/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const saved = "11111111-2222-4333-8444-555555555555";
const state = vi.hoisted(() => ({
  available: undefined as unknown, availableInput: [] as unknown[], statusInput: [] as unknown[],
  latest: { isSuccess: true, isError: false, data: { executionId: null as string | null } } as Record<string, unknown>,
  status: undefined as unknown, preflight: undefined as unknown, preflightError: false, preflightFetching: false,
}));
vi.mock("@/trpc/client", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return { trpc: {
    user: { getEntitlements: { useQuery: () => ({ data: undefined }) } },
    useUtils: () => ({ client: { runtime: { executeStream: { mutate: vi.fn() } } }, credits: { getBalance: { invalidate: vi.fn() } } }),
    runtime: {
      reportAvailable: { useQuery: (_input: unknown, options: { enabled: boolean }) => {
        state.availableInput.push(options.enabled);
        return { data: options.enabled ? state.available : undefined };
      } },
      reportPreflight: { useQuery: () => ({ data: state.preflight, isError: state.preflightError, isFetching: state.preflightFetching }) },
      choices: { useQuery: () => ({ data: { corePathV2: false } }) },
      reportLatest: { useQuery: () => ({ ...state.latest, refetch: vi.fn() }) },
      reportStatus: { useQuery: (input: { executionId: string }, options: { enabled: boolean }) => {
        state.statusInput.push(options.enabled ? input.executionId : null);
        return { data: options.enabled ? state.status : undefined, refetch: vi.fn() };
      } },
      reportStart: { useMutation: mutation }, cancel: { useMutation: mutation }, resume: { useMutation: mutation },
      reportDocument: { useQuery: () => ({ data: undefined, isError: false }) },
      reportSave: { useMutation: mutation }, reportFinalize: { useMutation: mutation },
    },
    fusionReview: { versionMarks: { useQuery: () => ({ data: undefined }) } },
    research: { chooseShortfall: { useMutation: mutation } },
  } };
});
// The jury entry has its own tests; here it only needs to stay out of the way.
vi.mock("@/components/fusion-review/JuryEntry", () => ({ JuryEntry: () => null }));
import { ReportEntry } from "./report-panel";

const props = { draftId: "d", sessionId: "s", projectId: "p", roundId: "r", busy: false, onTopics: () => {} };
const existing = () => {
  state.latest = { isSuccess: true, isError: false, data: { executionId: saved } };
  state.status = { executionId: saved, state: "completed", body: "## A\nx", completeness: "complete", candidate: true };
};
beforeEach(() => {
  state.available = { enabled: true, priceCredits: 500 };
  state.preflight = { canGenerate: true, qualified: 3, required: 3, rounds: 2, card: null };
  state.preflightError = false;
  state.preflightFetching = false;
  state.availableInput = [];
  state.statusInput = [];
  state.latest = { isSuccess: true, isError: false, data: { executionId: null } };
  state.status = undefined;
});

it("renders nothing while the server switch is off and the round has no report, so the page is unchanged", () => {
  state.available = { enabled: false };
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed />)).toBe("");
});
it("does not read the switch before every step is confirmed", () => {
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed={false} />)).toBe("");
  expect(state.availableInput).toEqual([false]);
});
it("renders nothing while the switch is unknown and there is no report", () => {
  state.available = undefined;
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed />)).toBe("");
});
it("keeps the entry while the saved-report read is unknown; the paid start inside waits (generationOffer)", () => {
  state.latest = { isSuccess: false, isError: false, data: undefined };
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed />)).toContain("生成完整报告");
  state.latest = { isSuccess: false, isError: true, data: undefined };
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed />)).toContain("生成完整报告");
});
it("shows the entry once confirmed and enabled, naming the fixed price and no model", () => {
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("生成完整报告");
  expect(html).toContain("500");
  expect(html).not.toMatch(/模型/);
});
it("shows the benchmark shortfall before any priced report offer or confirmation", () => {
  state.preflight = { canGenerate: false, qualified: 2, required: 3, rounds: 1, card: null };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("目前有 2 个合格对标，还未达到报告需要的 3 个");
  expect(html).toContain("继续找对标");
  expect(html).not.toContain("500");
  expect(html).not.toContain("确认并扣");
});
it("offers the existing shortfall choice before charging, after two search rounds", () => {
  state.preflight = { canGenerate: false, qualified: 2, required: 3, rounds: 2,
    card: { cardId: "choice", required: 3, offeredQualified: 2, offeredRounds: 2, choice: null, chosenQualified: null } };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("用现有 2 个对标先生成报告");
  expect(html).not.toContain("500");
});
it("offers the normal priced entry after the server confirms the user's shortfall choice", () => {
  state.preflight = { canGenerate: true, qualified: 2, required: 3, rounds: 2,
    card: { choice: "generate" } };
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed />)).toContain("生成完整报告（500 积分）");
});
it("waits for a readable eligibility result before offering a price", () => {
  state.preflight = undefined;
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("正在确认对标条件");
  expect(html).not.toContain("500");
});
it("does not reuse a stale passing eligibility after its read failed", () => {
  state.preflightError = true;
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("暂时无法确认对标条件");
  expect(html).not.toContain("500");
});
it("waits for a pending refresh instead of offering a price from an old passing eligibility", () => {
  state.preflightFetching = true;
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("正在确认对标条件");
  expect(html).not.toContain("500");
});
it("does not offer the shortfall generate choice after every qualified account was lost", () => {
  state.preflight = { canGenerate: false, qualified: 0, required: 3, rounds: 2,
    card: { cardId: "choice", required: 3, offeredQualified: 2, offeredRounds: 2, choice: null, chosenQualified: null } };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("继续找对标");
  expect(html).not.toContain("用现有 2 个对标先生成报告");
});
// Review P1 (#1129): a price that cannot be read offers no paid start at all.
it("offers no new report while the fixed price cannot be read", () => {
  state.available = { enabled: true, priceCredits: null };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).not.toContain("生成完整报告");
});
it("keeps a saved report readable with the switch off (rollback)", () => {
  existing();
  state.available = { enabled: false };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("完整运营策略报告");
  expect(html).not.toContain("生成完整报告");
  expect(state.statusInput).toContain(saved);
});
it("keeps an incomplete report readable and explains why another paid generation cannot start", () => {
  existing();
  state.status = { executionId: saved, state: "cancelled", body: null, completeness: null, candidate: false };
  state.preflight = { canGenerate: false, qualified: 2, required: 3, rounds: 1, card: null };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("完整运营策略报告");
  expect(html).toContain("目前有 2 个合格对标");
  expect(html).not.toContain("500");
});
it("keeps an existing report entry readable while its next-generation eligibility refreshes", () => {
  existing();
  state.preflightFetching = true;
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("完整运营策略报告");
  expect(html).not.toContain("生成完整报告（500 积分）");
});
it("finds the saved report from the server with no local record (cleared storage or another device)", () => {
  existing();
  // Server render has no localStorage at all: the same as a cleared browser or a second device.
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed={false} />);
  expect(html).toContain("完整运营策略报告");
  expect(state.statusInput).toContain(saved);
});
it("uses the public report name, not the superseded 定位报告", async () => {
  const { REPORT_TITLE } = await import("./report-gen");
  expect(REPORT_TITLE).toContain("运营策略报告");
  expect(REPORT_TITLE).not.toContain("定位报告");
});
it("remounts per project and round, so a revised round never shows the old round's report state", () => {
  const first = ReportEntry({ ...props, confirmed: true }) as { key: string | null; type: unknown };
  const revised = ReportEntry({ ...props, roundId: "r2", confirmed: true }) as { key: string | null; type: unknown };
  expect(first.key).toBe("p:r");
  expect(revised.key).toBe("p:r2");
  expect(revised.type).toBe(first.type);
  expect(ReportEntry({ ...props, projectId: "p2", confirmed: true })).toMatchObject({ key: "p2:r" });
});

// #1079/#1003: each jury adoption publishes a new round, while the generated report execution stays in the first round.
const formal = { available: true, id: "v3", report: { generatedReport: { body: "## 结论\n已采用的正文\n## 第一章\n内容" } } };
it("shows the saved formal report of a published round that has no report execution, never a new paid start", () => {
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed published report={formal} />);
  expect(html).toContain("完整运营策略报告");
  expect(html).not.toContain("生成完整报告");
});
it("shows the saved formal report with the switch off too", () => {
  state.available = { enabled: false };
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed published report={formal} />)).toContain("完整运营策略报告");
});
it("still offers a new report in a revision round (draft) even though the old version has a formal report", () => {
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed published={false} report={formal} />);
  expect(html).toContain("生成完整报告");
});
it("the dialog shows the saved formal text and no generate button", async () => {
  const { ReportDialog } = await import("./report-panel");
  const report = { executionId: null, status: null, live: null, streaming: false, refusal: null, offer: "start", starting: false,
    payg: { turnNotices: () => [] }, start: () => {}, restart: () => {}, stop: () => {}, stopUnconfirmed: false, retryStop: () => {} };
  const html = renderToStaticMarkup(<ReportDialog report={report as never} savedBody={formal.report.generatedReport.body}
    busy={false} onClose={() => {}} onTopics={() => {}} />);
  expect(html).toContain("已采用的正文");
  expect(html).not.toContain("生成完整报告");
});

// #716 2026-10-20: after a reload the footer says the report is still being written, and the dialog says why no text shows.
it("names a report that is still being written on the footer entry", () => {
  existing();
  state.status = { executionId: saved, state: "running", body: null, completeness: null, candidate: false };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("完整运营策略报告（生成中）");
});
const dialogReport = (fields: Record<string, unknown>) => ({ executionId: saved, status: null, live: null, streaming: false, refusal: null,
  offer: null, starting: false, reopened: false, payg: { turnNotices: () => [] }, start: () => {}, restart: () => {}, stop: () => {},
  stopUnconfirmed: false, retryStop: () => {}, ...fields });
it("says a reattached report is written in the background, with no text yet, and offers no export while it runs", async () => {
  const { ReportDialog } = await import("./report-panel");
  const { REPORT_REOPENED_NOTICE, REPORT_WRITING_NOTICE } = await import("./report-gen");
  const running = { executionId: saved, state: "running", body: null, completeness: null, candidate: false };
  const live = { executionId: saved, text: "", stopped: false };
  const render = (fields: Record<string, unknown>) => renderToStaticMarkup(<ReportDialog report={dialogReport(fields) as never}
    busy={false} onClose={() => {}} onTopics={() => {}} />);
  expect(render({ status: running, reopened: true })).toContain(REPORT_REOPENED_NOTICE);
  expect(render({ status: running, reopened: true, live, streaming: true })).toContain(REPORT_REOPENED_NOTICE);
  // This page's own start streams the text, so it says it is writing.
  const own = render({ status: running, live: { ...live, text: "## 一" }, streaming: true });
  expect(own).toContain(REPORT_WRITING_NOTICE);
  expect(own).not.toContain(REPORT_REOPENED_NOTICE);
  expect(render({ status: running, reopened: true })).not.toContain("导出报告");
});
it("offers 导出报告 for a finished report and for a saved formal version", async () => {
  const { ReportDialog } = await import("./report-panel");
  const done = { executionId: saved, state: "completed", body: "## A\nx", completeness: "complete", candidate: true };
  expect(renderToStaticMarkup(<ReportDialog report={dialogReport({ status: done }) as never}
    busy={false} onClose={() => {}} onTopics={() => {}} />)).toContain("导出报告");
  expect(renderToStaticMarkup(<ReportDialog report={dialogReport({ executionId: null }) as never}
    savedBody={formal.report.generatedReport.body} busy={false} onClose={() => {}} onTopics={() => {}} />)).toContain("导出报告");
});
