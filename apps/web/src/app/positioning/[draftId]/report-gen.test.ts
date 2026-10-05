/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { STOPPED_NOTICE } from "./stop-reply";
import {
  readReportRecord, REPORT_DISABLED_NOTICE, REPORT_EMPTY_NOTICE, REPORT_INCOMPLETE_NOTICE, REPORT_INTRO, REPORT_STOPPED_NOTICE,
  REPORT_TRUNCATED_NOTICE, REPORT_UNCONFIRMED_NOTICE, reportAttachable, reportCanStart, reportProgressing, reportRecordKey,
  reportStartRefusal, reportView, startedExecution, writeReportRecord, type ReportStatus,
} from "./report-gen";

const id = "11111111-2222-4333-8444-555555555555";
const status = (fields: Partial<ReportStatus>): ReportStatus =>
  ({ executionId: id, state: "completed", cursor: 1, epoch: 0, body: "## A\nx", completeness: "complete", candidate: true, ...fields });

describe("reportStartRefusal", () => {
  it.each([
    "REPORT_MEMBERSHIP_REQUIRED", "REPORT_ENTITLEMENTS_UNAVAILABLE", "REPORT_SOURCE_CONFLICT", "REPORT_CONFIRMATION_REQUIRED",
    "REPORT_MANIFEST_REQUIRED", "REPORT_PAYG_REQUIRED", "REPORT_FACTS_TOO_LARGE", "OPC_CAPTURE_PENDING",
  ])("maps %s to fixed Chinese text without credits, models or admins", code => {
    const { text } = reportStartRefusal(new Error(code));
    expect(text).not.toBe(REPORT_UNCONFIRMED_NOTICE);
    expect(text).toMatch(/[一-鿿]/);
    expect(text).not.toMatch(/积分|credit|管理员|配置|Claude|Sonnet|GPT|Gemini|模型/i);
  });
  it("offers membership only for the membership refusal", () => {
    expect(reportStartRefusal(new Error("REPORT_MEMBERSHIP_REQUIRED")).membership).toBe(true);
    expect(reportStartRefusal(new Error("REPORT_ENTITLEMENTS_UNAVAILABLE")).membership).toBeUndefined();
  });
  it("hides the entry when the switch turned off", () => {
    expect(reportStartRefusal(new Error("REPORT_DISABLED"))).toEqual({ text: REPORT_DISABLED_NOTICE, hideEntry: true });
  });
  it.each([new Error("REPORT_UNAVAILABLE"), new Error("fetch failed"), "x", null])("never shows server text (%s)", cause => {
    expect(reportStartRefusal(cause)).toEqual({ text: REPORT_UNCONFIRMED_NOTICE });
  });
  it("keeps the intro free of predicted cost", () => {
    expect(REPORT_INTRO).not.toMatch(/积分|费|标价/);
  });
});

describe("reportView", () => {
  it("shows a complete candidate as the report", () => {
    expect(reportView(status({}))).toEqual({ kind: "report", body: "## A\nx", notices: [], candidate: true });
  });
  it("shows a length_limit report with the truncation notice and never as a candidate", () => {
    expect(reportView(status({ completeness: "length_limit", candidate: false })))
      .toEqual({ kind: "report", body: "## A\nx", notices: [REPORT_TRUNCATED_NOTICE], candidate: false });
    // A malformed status claiming candidacy for a truncated body still is not one.
    expect(reportView(status({ completeness: "length_limit", candidate: true }))).toMatchObject({ candidate: false });
  });
  it("marks a complete body that failed structure validation", () => {
    expect(reportView(status({ candidate: false }))).toMatchObject({ notices: [REPORT_INCOMPLETE_NOTICE], candidate: false });
  });
  it("keeps a stopped report readable and not final", () => {
    expect(reportView(status({ state: "completed", completeness: "stopped", candidate: false })))
      .toMatchObject({ notices: [STOPPED_NOTICE, REPORT_STOPPED_NOTICE], candidate: false });
  });
  it.each(["waiting_credits", "waiting_resume"])("hands %s to the PAYG notices", state => {
    expect(reportView(status({ state, body: null, completeness: null, candidate: false }))).toEqual({ kind: "waiting" });
  });
  it.each(["prepared", "running", "stopping", "interrupted", "cost_pending"])("%s is still progressing", state => {
    const view = reportView(status({ state, body: null, completeness: null, candidate: false }));
    expect(view.kind).toBe("progress");
    expect(reportProgressing({ state })).toBe(true);
  });
  it("only attaches a stream to states the server can still run or replay", () => {
    expect(["prepared", "running", "interrupted"].every(state => reportAttachable({ state }))).toBe(true);
    expect(["stopping", "cost_pending", "completed", "waiting_credits", "cancelled"].some(state => reportAttachable({ state }))).toBe(false);
  });
  it.each(["completed", "cancelled"])("%s without a body has no report and allows a new request", state => {
    const saved = status({ state, body: null, completeness: null, candidate: false });
    expect(reportView(saved)).toEqual({ kind: "empty", notice: REPORT_EMPTY_NOTICE });
    expect(reportCanStart(saved)).toBe(true);
  });
  it("never offers a new paid request over a saved or running report", () => {
    expect(reportCanStart(status({}))).toBe(false);
    expect(reportCanStart(status({ completeness: "length_limit", candidate: false }))).toBe(false);
    expect(reportCanStart(status({ state: "running", body: null }))).toBe(false);
    expect(reportCanStart(status({ state: "waiting_credits", body: null }))).toBe(false);
    expect(reportCanStart(null)).toBe(true);
  });
});

describe("report record", () => {
  const memory = () => {
    const values = new Map<string, string>();
    return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k) };
  };
  it("is keyed by draft and round, so a revised round starts fresh", () => {
    expect(reportRecordKey("d", "r1")).not.toBe(reportRecordKey("d", "r2"));
  });
  it("round-trips the retained request and execution", () => {
    const storage = memory(), key = reportRecordKey("d", "r");
    writeReportRecord(storage, key, { requestId: id });
    expect(readReportRecord(storage, key)).toEqual({ requestId: id });
    writeReportRecord(storage, key, { requestId: id, executionId: id });
    expect(readReportRecord(storage, key)).toEqual({ requestId: id, executionId: id });
  });
  it.each(["not json", "null", '{"requestId":"x"}', '{"executionId":"' + id + '"}'])("ignores a malformed record %s", raw => {
    const storage = memory();
    storage.setItem("k", raw);
    expect(readReportRecord(storage, "k")).toBeNull();
  });
  it("drops a malformed executionId but keeps the request", () => {
    const storage = memory();
    storage.setItem("k", JSON.stringify({ requestId: id, executionId: "nope" }));
    expect(readReportRecord(storage, "k")).toEqual({ requestId: id });
  });
  it("survives unusable storage", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => undefined };
    expect(readReportRecord(broken, "k")).toBeNull();
    expect(() => writeReportRecord(broken, "k", { requestId: id })).not.toThrow();
    expect(readReportRecord(null, "k")).toBeNull();
  });
  it("reads only a uuid executionId from reportStart", () => {
    expect(startedExecution({ executionId: id, runId: id, state: "prepared" })).toBe(id);
    expect(startedExecution({ admitted: false })).toBeNull();
    expect(startedExecution(null)).toBeNull();
  });
});
