/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ available: undefined as unknown, availableInput: [] as unknown[], statusEnabled: [] as unknown[] }));
vi.mock("@/trpc/client", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return { trpc: {
    useUtils: () => ({ client: { runtime: { executeStream: { mutate: vi.fn() } } }, credits: { getBalance: { invalidate: vi.fn() } } }),
    runtime: {
      reportAvailable: { useQuery: (_input: unknown, options: { enabled: boolean }) => {
        state.availableInput.push(options.enabled);
        return { data: options.enabled ? state.available : undefined };
      } },
      reportStatus: { useQuery: (_input: unknown, options: { enabled: boolean }) => {
        state.statusEnabled.push(options.enabled);
        return { data: undefined, refetch: vi.fn() };
      } },
      reportStart: { useMutation: mutation }, cancel: { useMutation: mutation }, resume: { useMutation: mutation },
    },
  } };
});
import { ReportEntry } from "./report-panel";

const props = { draftId: "d", sessionId: "s", projectId: "p", roundId: "r", busy: false };
beforeEach(() => {
  state.available = { enabled: true };
  state.availableInput = [];
  state.statusEnabled = [];
});

it("renders nothing while the server switch is off, so the page is unchanged", () => {
  state.available = { enabled: false };
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed />)).toBe("");
});
it("does not even read the switch before every step is confirmed", () => {
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed={false} />)).toBe("");
  expect(state.availableInput).toEqual([false]);
  expect(state.statusEnabled).toEqual([false]);
});
it("renders nothing while the switch is unknown", () => {
  state.available = undefined;
  expect(renderToStaticMarkup(<ReportEntry {...props} confirmed />)).toBe("");
});
it("shows the entry once confirmed and enabled, without cost or model wording", () => {
  const html = renderToStaticMarkup(<ReportEntry {...props} confirmed />);
  expect(html).toContain("生成完整报告");
  expect(html).not.toMatch(/积分|模型/);
});
it("uses the public report name, not the superseded 定位报告", async () => {
  const { REPORT_TITLE } = await import("./report-gen");
  expect(REPORT_TITLE).toContain("运营策略报告");
  expect(REPORT_TITLE).not.toContain("定位报告");
});
