/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { askedVersion, bodyFromEditor, canFinalize, editorText, savedAs, canSave, finalizedNotice, REPORT_DOC_UNAVAILABLE, reportDocumentError, reportLength, requestFor } from "./report-document";

const doc = { body: "## 定位\n原文", finalized: false, candidate: true };

describe("report document (R5)", () => {
  it("counts Unicode characters like the server", () => {
    expect(reportLength("定位😀")).toBe(3);
  });

  it("saves only a changed, non-empty body within 12000 characters, never after 定稿", () => {
    expect(canSave(doc, doc.body)).toBe(false);
    expect(canSave(doc, "   ")).toBe(false);
    expect(canSave(doc, "改过的正文")).toBe(true);
    expect(canSave(doc, "字".repeat(12000))).toBe(true);
    expect(canSave(doc, "字".repeat(12001))).toBe(false);
    expect(canSave({ ...doc, finalized: true }, "改过的正文")).toBe(false);
  });

  it("finalizes only a complete, unfinalized report that is not being edited", () => {
    expect(canFinalize(doc, false)).toBe(true);
    expect(canFinalize(doc, true)).toBe(false);
    expect(canFinalize({ ...doc, candidate: false }, false)).toBe(false);
    expect(canFinalize({ ...doc, finalized: true }, false)).toBe(false);
  });

  it("reuses the request id only for the same intent", () => {
    let n = 0;
    const id = () => "id" + ++n;
    const first = requestFor(null, ["e", "save", 0, "甲"], id);
    expect(requestFor(first, ["e", "save", 0, "甲"], id)).toBe(first);
    expect(requestFor(first, ["e", "save", 0, "乙"], id).requestId).toBe("id2");
    expect(requestFor(first, ["e", "finalize", 0, "hash"], id).requestId).toBe("id3");
  });

  it("explains every stable code with fixed text and never shows server text", () => {
    for (const code of ["REPORT_AUTH_REQUIRED", "REPORT_EXECUTION_REQUIRED", "REPORT_SOURCE_CONFLICT", "REPORT_CONFIRMATION_REQUIRED",
      "REPORT_NOT_COMPLETE", "REPORT_EVIDENCE_CAPACITY", "REPORT_BODY_INVALID", "REPORT_VERSION_CONFLICT", "REPORT_REQUEST_CONFLICT",
      "REPORT_ALREADY_FINALIZED", "CONTENT_ERASED"]) {
      const error = reportDocumentError(new Error(code));
      expect(error.known).toBe(true);
      expect(error.text).not.toContain(code);
      expect(error.text).not.toMatch(/积分|扣费/);
    }
    for (const cause of [new Error("REPORT_UNAVAILABLE"), new Error("fetch failed"), new Error("toString"), "x"])
      expect(reportDocumentError(cause)).toMatchObject({ known: false, text: REPORT_DOC_UNAVAILABLE });
  });

  it("keeps the user's text on a version conflict", () => {
    expect(reportDocumentError(new Error("REPORT_VERSION_CONFLICT")).text).toContain("修改仍保留");
  });

  it("closes the 定稿 question when another version appears", () => {
    const asked = { revision: 1, bodyHash: "a" };
    expect(askedVersion(asked, { revision: 1, bodyHash: "a" })).toBe(asked);
    expect(askedVersion(asked, { revision: 2, bodyHash: "b" })).toBeNull();
    expect(askedVersion(asked, { revision: 1, bodyHash: "b" })).toBeNull();
    expect(askedVersion(null, { revision: 1, bodyHash: "a" })).toBeNull();
  });

  it("keeps the draft when a replayed save answers with another tab's newer text", () => {
    expect(savedAs({ body: "我的修改", manuallyEdited: true }, "我的修改")).toBe(true);
    expect(savedAs({ body: "别处的修改", manuallyEdited: true }, "我的修改")).toBe(false);
  });

  it("names the official version after 定稿", () => {
    expect(finalizedNotice(3)).toBe("报告已定稿，成为正式定位第 3 版。");
    expect(finalizedNotice(null)).toBe("报告已定稿，成为正式定位版本。");
  });

  it("edits the report text only: the strategy data block is hidden, not counted, and put back unchanged", () => {
    const block = '```graylum-report-data\n{"v":1,"field":"summary","value":"先做小红书"}\n```';
    const doc = { body: `## 一句话结论\n\n先做小红书。\n\n${block}`, finalized: false };
    expect(editorText(doc.body)).toBe("## 一句话结论\n\n先做小红书。");
    expect(canSave(doc, editorText(doc.body))).toBe(false);
    expect(bodyFromEditor(doc, "## 一句话结论\n\n改成抖音。")).toBe(`## 一句话结论\n\n改成抖音。\n\n${block}`);
    expect(canSave(doc, "字".repeat(12000))).toBe(true);
    expect(bodyFromEditor({ body: "## 旧报告" }, "## 改过")).toBe("## 改过");
    // A stored body that ends with a newline after the block: opening the editor is not a change.
    expect(canSave({ ...doc, body: doc.body + "\n" }, editorText(doc.body + "\n"))).toBe(false);
  });
});
