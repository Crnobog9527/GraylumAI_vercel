/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ read: {} as Record<string, unknown> }));
vi.mock("@/trpc/client", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return { trpc: {
    useUtils: () => ({ runtime: { reportDocument: { setData: vi.fn() } } }),
    runtime: { reportDocument: { useQuery: () => ({ ...state.read, refetch: vi.fn() }) },
      reportSave: { useMutation: mutation }, reportFinalize: { useMutation: mutation } },
  } };
});
import { ReportDocumentPanel } from "./report-document-panel";

const execution = "11111111-2222-4333-8444-555555555555";
const doc = { executionId: execution, revision: 0, body: "## 当前正文", bodyHash: "a".repeat(64), manuallyEdited: false,
  completeness: "complete", candidate: true, finalized: false, versionId: null, version: null, next: null };
const render = (props: Partial<Parameters<typeof ReportDocumentPanel>[0]> = {}) => renderToStaticMarkup(
  <ReportDocumentPanel executionId={execution} fallbackBody="## 生成时正文" generatedComplete busy={false} onTopics={() => {}} {...props} />);
beforeEach(() => { state.read = { data: doc, isError: false }; });

it("shows the current version with 修改报告 and 定稿", () => {
  const html = render();
  expect(html).toContain("当前正文");
  expect(html).toContain("修改报告");
  expect(html).toMatch(/<button[^>]*>定稿<\/button>/);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>定稿</);
  expect(html).not.toContain("报告已手动修改");
});

it("marks a manual version and says the confirmed steps are unchanged", () => {
  state.read = { data: { ...doc, revision: 2, manuallyEdited: true }, isError: false };
  const html = render();
  expect(html).toContain("报告已手动修改");
  expect(html).toContain("不改动各步已确认的内容");
});

it("does not allow 定稿 when the current text is not complete", () => {
  state.read = { data: { ...doc, manuallyEdited: true, revision: 1, candidate: false }, isError: false };
  const html = render();
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>定稿</);
  expect(html).toContain("不能定稿");
  // A truncated or stopped generation already has its own notice in the dialog.
  expect(render({ generatedComplete: false })).not.toContain("不能定稿");
});

it("after 定稿 shows the version, no editing, and the explicit topics step only when the server offers it", () => {
  state.read = { data: { ...doc, finalized: true, versionId: "v", version: 2 }, isError: false };
  let html = render();
  expect(html).toContain("成为正式定位第 2 版");
  expect(html).not.toContain("修改报告");
  expect(html).not.toContain("继续生成第一周选题");
  state.read = { data: { ...doc, finalized: true, versionId: "v", version: 2,
    next: { kind: "first_week_topics", draftId: "d", sourceVersionId: "v" } }, isError: false };
  html = render();
  expect(html).toContain("继续生成第一周选题");
});

it("falls back to the generated text, without edit or 定稿, until the document is read", () => {
  state.read = { data: undefined, isError: false };
  let html = render();
  expect(html).toContain("生成时正文");
  expect(html).not.toContain("修改报告");
  state.read = { data: undefined, isError: true };
  html = render();
  expect(html).toContain("暂时无法读取报告的最新版本");
});

it("locks the actions while the page is busy", () => {
  const html = render({ busy: true });
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>定稿</);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>修改报告</);
});
