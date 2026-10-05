/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { STOPPED_NOTICE } from "./stop-reply";
import {
  readReportRecord, REPORT_DISABLED_NOTICE, REPORT_EMPTY_NOTICE, REPORT_INCOMPLETE_NOTICE, REPORT_INTRO, REPORT_STOPPED_NOTICE,
  REPORT_TRUNCATED_NOTICE, REPORT_UNCONFIRMED_NOTICE, reportAttachable, reportCanStart, reportProgressing, reportRecordKey,
  reportResultRefusal, reportStartRefusal, reportView, startedExecution, writeReportRecord, type ReportStatus,
  ATTACH_RETRY_DELAYS_MS, attachRetryDelay, generationOffer, needsReattach, nextRequestId, REPORT_ALREADY_EXISTS_NOTICE, shownExecution,
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

describe("reportResultRefusal", () => {
  it("turns a lapsed membership on resume into the membership prompt", () => {
    expect(reportResultRefusal({ state: "cancelled", code: "REPORT_MEMBERSHIP_REQUIRED" })).toMatchObject({ membership: true });
  });
  it.each(["REPORT_ENTITLEMENTS_UNAVAILABLE", "REPORT_SOURCE_CONFLICT"])("explains %s", code => {
    expect(reportResultRefusal({ code })?.text).toBe(reportStartRefusal(new Error(code)).text);
  });
  it.each([{ code: "RUNTIME_WAITING_CREDITS" }, { state: "completed" }, null, "x"])("ignores %j", result => {
    expect(reportResultRefusal(result)).toBeNull();
  });
});

describe("restoring and offering", () => {
  const other = "99999999-2222-4333-8444-555555555555";
  const at = (executionId: string | null, answeredAt = 1) => ({ kind: "known", executionId, answeredAt }) as const;
  it("takes the server's report over a missing or stale local pointer", () => {
    expect(shownExecution(null, at(id), null)).toBe(id);
    expect(shownExecution(null, at(id), { requestId: other, executionId: other })).toBe(id);
    expect(shownExecution(null, at(null), { requestId: other, executionId: other })).toBeNull();
  });
  it("keeps a just-started execution while the server catches up, and falls back to local only when the server is unreadable", () => {
    // An answer from before the pin still names the old report; an answer after it does not name one yet.
    expect(shownExecution({ executionId: other, since: 10 }, at(id, 5), null)).toBe(other);
    expect(shownExecution({ executionId: other, since: 10 }, at(null, 20), null)).toBe(other);
    expect(shownExecution({ executionId: other, since: 10 }, { kind: "pending" }, null)).toBe(other);
    expect(shownExecution(null, { kind: "failed" }, { requestId: other, executionId: other })).toBe(other);
    expect(shownExecution(null, { kind: "pending" }, null)).toBeNull();
  });
  it("follows the server when another tab made a replacement report after this tab's pin", () => {
    const replacement = "33333333-2222-4333-8444-555555555555";
    expect(shownExecution({ executionId: other, since: 10 }, at(replacement, 20), null)).toBe(replacement);
    // The server caught up to this tab's own execution: the same one either way.
    expect(shownExecution({ executionId: other, since: 10 }, at(other, 20), null)).toBe(other);
  });
  const known = { kind: "known", executionId: null, answeredAt: 1 } as const;
  it("offers a first start only for a round the server shows without a report", () => {
    expect(generationOffer({ canGenerate: true, working: false, server: known, executionId: null, status: null })).toBe("start");
    for (const server of [{ kind: "pending" }, { kind: "failed" }] as const)
      expect(generationOffer({ canGenerate: true, working: false, server, executionId: null, status: null })).toBeNull();
    expect(generationOffer({ canGenerate: false, working: false, server: known, executionId: null, status: null })).toBeNull();
    expect(generationOffer({ canGenerate: true, working: true, server: known, executionId: null, status: null })).toBeNull();
  });
  it.each([
    ["a saved report", status({})], ["a truncated report", status({ completeness: "length_limit", candidate: false })],
    ["a running report", status({ state: "running", body: null })], ["a report waiting for credits", status({ state: "waiting_credits", body: null })],
    ["a status still loading", null], ["a status of another execution", status({ executionId: other, body: null, state: "cancelled" })],
  ])("never offers a paid start over %s", (_name, saved) => {
    expect(generationOffer({ canGenerate: true, working: false, server: { kind: "known", executionId: id, answeredAt: 1 }, executionId: id, status: saved }))
      .toBeNull();
  });
  it("offers a new request only after the round's last report ended without text", () => {
    const empty = status({ state: "cancelled", body: null, completeness: null, candidate: false });
    expect(generationOffer({ canGenerate: true, working: false, server: { kind: "known", executionId: id, answeredAt: 1 }, executionId: id, status: empty }))
      .toBe("restart");
  });
  it("re-attaches a stream that ended with the execution unfinished on the server", () => {
    expect(needsReattach({ state: "pending" })).toBe(true);
    expect(needsReattach({ state: "interrupted" })).toBe(true);
    for (const state of ["completed", "cancelled", "waiting_credits", "waiting_resume", "cost_pending"])
      expect(needsReattach({ state })).toBe(false);
    expect(needsReattach(null)).toBe(false);
  });
  it("bounds the attach retries", () => {
    expect(ATTACH_RETRY_DELAYS_MS.map((_, attempt) => attachRetryDelay(attempt))).toEqual(ATTACH_RETRY_DELAYS_MS);
    expect(attachRetryDelay(ATTACH_RETRY_DELAYS_MS.length)).toBeNull();
  });
});

describe("one report per round", () => {
  it("opens the existing report when the server refuses a second one", () => {
    expect(reportStartRefusal(new Error("REPORT_ALREADY_EXISTS"))).toEqual({ text: REPORT_ALREADY_EXISTS_NOTICE, opened: true });
    expect(REPORT_ALREADY_EXISTS_NOTICE).not.toMatch(/积分|模型|管理员/);
  });
  it("resends a pending request on 重新生成 until the server answers with an execution", () => {
    const mint = () => "22222222-2222-4333-8444-555555555555";
    // The restart's admission answer was lost: only its requestId was kept.
    expect(nextRequestId({ requestId: id }, mint)).toBe(id);
    // Clicked again and lost again: still the same request.
    expect(nextRequestId({ requestId: id }, mint)).toBe(id);
    // The server answered with an execution (which later ended empty): only now a new request.
    expect(nextRequestId({ requestId: id, executionId: id }, mint)).toBe(mint());
    expect(nextRequestId(null, mint)).toBe(mint());
  });
});
