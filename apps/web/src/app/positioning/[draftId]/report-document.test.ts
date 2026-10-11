/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { canFinalize, canSave, finalizedNotice, REPORT_DOC_UNAVAILABLE, reportDocumentError, reportLength, requestFor } from "./report-document";

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

  it("names the official version after 定稿", () => {
    expect(finalizedNotice(3)).toBe("报告已定稿，成为正式定位第 3 版。");
    expect(finalizedNotice(null)).toBe("报告已定稿，成为正式定位版本。");
  });
});
