/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { savedFormalEditable } from "./saved-report";
import { clearDraft, readDraft, SAVED_EDIT_TEXT, savedEditError, writeDraft } from "./saved-report-edit";

vi.mock("@/trpc/client", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return { trpc: { useUtils: () => ({ opc: { read: { invalidate: vi.fn() } } }),
    runtime: { reportRevisionPropose: { useMutation: mutation }, reportRevisionApply: { useMutation: mutation } } } };
});
import { SavedReportEditor } from "./saved-report-editor";

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k), key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; } };
};
const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); },
  key: () => { throw new Error("blocked"); }, get length(): number { throw new Error("blocked"); } };

it("keeps the draft per project and per source version, and clears it", () => {
  const s = memory();
  writeDraft("p", "v1", "草稿一", s); writeDraft("p", "v2", "草稿二", s); writeDraft("q", "v1", "别的项目", s);
  expect(readDraft("p", "v1", s)).toBe("草稿一");
  expect(readDraft("p", "v2", s)).toBe("草稿二");
  expect(readDraft("p", "v3", s)).toBeNull();
  clearDraft("p", "v1", s);
  expect(readDraft("p", "v1", s)).toBeNull();
  expect(readDraft("q", "v1", s)).toBe("别的项目");
});

it("never throws when the browser storage is blocked, full or missing", () => {
  expect(() => { writeDraft("p", "v", "x", broken); clearDraft("p", "v", broken); }).not.toThrow();
  expect(readDraft("p", "v", broken)).toBeNull();
  expect(readDraft("p", "v", null)).toBeNull();
  expect(() => { writeDraft("p", "v", "x", null); }).not.toThrow();
});

it("explains each refusal in fixed words, and marks a stale source version so the draft is dropped", () => {
  expect(savedEditError(new Error("REPORT_REVISION_STALE"))).toMatchObject({ stale: true, text: SAVED_EDIT_TEXT.stale });
  expect(savedEditError(new Error("REPORT_SOURCE_CONFLICT"))).toMatchObject({ stale: true });
  expect(savedEditError(new Error("REPORT_NOT_COMPLETE"))).toMatchObject({ known: true, stale: false });
  const unknown = savedEditError(new Error("SOMETHING <server text>"));
  expect(unknown).toMatchObject({ known: false, stale: false });
  expect(unknown.text).not.toContain("server text");
});

it("shows the saved report and an edit button first, with no editor until the user asks", () => {
  const html = renderToStaticMarkup(<SavedReportEditor draftId="d" projectId="p" versionId="v" body={"## A\n正文"} busy={false}
    view={<div>已保存的报告</div>} />);
  expect(html).toContain("已保存的报告");
  expect(html).toContain(SAVED_EDIT_TEXT.edit);
  expect(html).not.toContain("<textarea");
});

it("edits only a version made by a jury adoption, never an ordinary finalized report (whatever the execution lookup says)", () => {
  const adopted = { available: true, id: "v2", report: { generatedReport: { body: "## A\nx", source: "review_revision" } } };
  const ordinary = { available: true, id: "v1", report: { generatedReport: { body: "## A\nx" } } };
  expect(savedFormalEditable(adopted)).toBe(true);
  expect(savedFormalEditable(ordinary)).toBe(false);
  expect(savedFormalEditable({ ...adopted, available: false })).toBe(false);
  expect(savedFormalEditable({ ...adopted, id: null })).toBe(false);
  expect(savedFormalEditable(null)).toBe(false);
});
