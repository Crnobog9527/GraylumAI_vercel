/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const saved = "11111111-2222-4333-8444-555555555555";
const state = vi.hoisted(() => ({
  available: undefined as unknown, availableInput: [] as unknown[], statusInput: [] as unknown[],
  latest: { isSuccess: true, isError: false, data: { executionId: null as string | null } } as Record<string, unknown>,
  status: undefined as unknown,
}));
vi.mock("@/trpc/client", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return { trpc: {
    useUtils: () => ({ client: { runtime: { executeStream: { mutate: vi.fn() } } }, credits: { getBalance: { invalidate: vi.fn() } } }),
    runtime: {
      reportAvailable: { useQuery: (_input: unknown, options: { enabled: boolean }) => {
        state.availableInput.push(options.enabled);
        return { data: options.enabled ? state.available : undefined };
      } },
      reportLatest: { useQuery: () => ({ ...state.latest, refetch: vi.fn() }) },
      reportStatus: { useQuery: (input: { executionId: string }, options: { enabled: boolean }) => {
        state.statusInput.push(options.enabled ? input.executionId : null);
        return { data: options.enabled ? state.status : undefined, refetch: vi.fn() };
      } },
      reportStart: { useMutation: mutation }, cancel: { useMutation: mutation }, resume: { useMutation: mutation },
    },
  } };
});
import { ReportEntry } from "./report-panel";

const props = { draftId: "d", sessionId: "s", projectId: "p", roundId: "r", busy: false };
const existing = () => {
  state.latest = { isSuccess: true, isError: false, data: { executionId: saved } };
  state.status = { executionId: saved, state: "completed", body: "## A\nx", completeness: "complete", candidate: true };
};
beforeEach(() => {
  state.available = { enabled: true };
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
it("shows the entry once confirmed and enabled, without cost or model wording", () => {
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("生成完整报告");
  expect(html).not.toMatch(/积分|模型/);
});
it("keeps a saved report readable with the switch off (rollback)", () => {
  existing();
  state.available = { enabled: false };
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("完整运营策略报告");
  expect(html).not.toContain("生成完整报告");
  expect(state.statusInput).toContain(saved);
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
