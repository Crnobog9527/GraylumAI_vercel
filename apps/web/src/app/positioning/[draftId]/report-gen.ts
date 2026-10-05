/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { STOPPED_NOTICE } from "./stop-reply";

/**
 * REPORT-GEN on the positioning page (#667 backend), without React so the rules are testable.
 * The entry follows the server switch (`runtime.reportAvailable`); membership, sources and money
 * are checked by the server, the page only explains its answer. No predicted credit cost and no
 * model names are ever shown (MASTER_PLAN §2.1 items 25, 50).
 */
export const REPORT_TITLE = "完整运营策略报告";
export const REPORT_INTRO = "所有步骤都已确认。导师会根据你确认的全部信息写一份完整报告，边写边显示。";
export const REPORT_ACTION = { start: "生成完整报告", retry: "重新生成", membership: "查看会员方案" } as const;
export const REPORT_WRITING_NOTICE = "正在写报告…";
export const REPORT_RUNNING_NOTICE = "报告正在生成…";
export const REPORT_COST_PENDING_NOTICE = "报告已写完，正在核对费用…";
export const REPORT_TRUNCATED_NOTICE = "这份报告写到了单次长度上限，在这里截断了，后面的部分没有写出来。截断的报告不能作为正式报告。";
export const REPORT_INCOMPLETE_NOTICE = "这份报告的结构不完整，不能作为正式报告。";
export const REPORT_STOPPED_NOTICE = "停止的报告不能作为正式报告。";
export const REPORT_EMPTY_NOTICE = "这次没有生成报告。";
export const REPORT_UNCONFIRMED_NOTICE = "开始生成的结果暂未确认。再点一次“生成完整报告”会接着同一次请求，不会重复扣费。";
export const REPORT_DISABLED_NOTICE = "报告生成暂未开放。";
export const REPORT_ALREADY_EXISTS_NOTICE = "这一轮已经有报告了，已为你打开。";

const startRefusals: Record<string, string> = {
  REPORT_DISABLED: REPORT_DISABLED_NOTICE,
  REPORT_MEMBERSHIP_REQUIRED: "生成完整报告需要开通会员。你已确认的信息都会保留。",
  REPORT_ENTITLEMENTS_UNAVAILABLE: "暂时无法核对会员状态，报告没有开始生成。请稍后再试。",
  REPORT_SOURCE_CONFLICT: "确认的信息刚刚有变化，报告没有开始生成。请刷新页面核对后再生成。",
  REPORT_CONFIRMATION_REQUIRED: "还有步骤没有确认。全部步骤确认后才能生成报告。",
  REPORT_MANIFEST_REQUIRED: "这个定位流程暂时不支持生成完整报告。",
  REPORT_PAYG_REQUIRED: "报告生成暂时不可用，报告没有开始生成。请稍后再试。",
  REPORT_FACTS_TOO_LARGE: "确认的信息太长，暂时无法一次写成报告。",
  OPC_CAPTURE_PENDING: "右侧信息还在整理，请等整理完成后再生成。",
  REPORT_ALREADY_EXISTS: REPORT_ALREADY_EXISTS_NOTICE,
};

/** `opened`: the round already has its report on the server; the page shows that one instead. */
export type StartRefusal = { text: string; membership?: true; hideEntry?: true; opened?: true };

/** Fixed text for a refused or lost `reportStart`; server text is never shown. */
export function reportStartRefusal(cause: unknown): StartRefusal {
  const message = cause instanceof Error ? cause.message : "";
  const text = startRefusals[message];
  if (!text) return { text: REPORT_UNCONFIRMED_NOTICE };
  if (message === "REPORT_MEMBERSHIP_REQUIRED") return { text, membership: true };
  if (message === "REPORT_DISABLED") return { text, hideEntry: true };
  if (message === "REPORT_ALREADY_EXISTS") return { text, opened: true };
  return { text };
}

/**
 * A run refused after admission (a resume or stream answer `code`): membership lapsed while
 * waiting for credits, or the confirmed sources changed. Nothing new was called.
 */
export function reportResultRefusal(result: unknown): StartRefusal | null {
  const code = result && typeof result === "object" ? (result as { code?: unknown }).code : null;
  return typeof code === "string" && ["REPORT_MEMBERSHIP_REQUIRED", "REPORT_ENTITLEMENTS_UNAVAILABLE", "REPORT_SOURCE_CONFLICT"].includes(code)
    ? reportStartRefusal(new Error(code)) : null;
}

/** Exactly `runtime.reportStatus`. */
export type ReportStatus = {
  executionId: string; state: string; cursor?: number | null; epoch?: number | null;
  body: string | null; completeness: string | null; candidate: boolean; code?: string | null;
};

/** States the server still advances by itself; the page re-reads them. */
const PROGRESSING = ["prepared", "running", "stopping", "interrupted", "cost_pending"];
/** An execution the page may attach its stream to again (a reload, a lost stream). Replays never call twice. */
const ATTACHABLE = ["prepared", "running", "interrupted"];

export function reportProgressing(status: Pick<ReportStatus, "state"> | null | undefined) {
  return Boolean(status && PROGRESSING.includes(status.state));
}
export function reportAttachable(status: Pick<ReportStatus, "state"> | null | undefined) {
  return Boolean(status && ATTACHABLE.includes(status.state));
}

export type ReportView =
  | { kind: "progress"; body: string | null; notice: string }
  | { kind: "waiting" }
  | { kind: "report"; body: string; notices: string[]; candidate: boolean }
  | { kind: "empty"; notice: string };

/**
 * What a saved report execution shows. Only `complete` and `candidate` is a full report; a
 * `length_limit` keeps its text with the truncation notice (charged like any reply, Owner
 * 2026-10-06) and is never offered for finalizing. Saved output stays readable whatever the
 * membership is now.
 */
export function reportView(status: ReportStatus): ReportView {
  if (status.state === "waiting_credits" || status.state === "waiting_resume") return { kind: "waiting" };
  if (status.state === "cost_pending") return { kind: "progress", body: status.body, notice: REPORT_COST_PENDING_NOTICE };
  if (reportProgressing(status)) return { kind: "progress", body: status.body, notice: REPORT_RUNNING_NOTICE };
  if (!status.body) return { kind: "empty", notice: REPORT_EMPTY_NOTICE };
  if (status.completeness === "complete" && status.candidate) return { kind: "report", body: status.body, notices: [], candidate: true };
  const notices = status.completeness === "length_limit" ? [REPORT_TRUNCATED_NOTICE]
    : status.completeness === "stopped" ? [STOPPED_NOTICE, REPORT_STOPPED_NOTICE]
    : [REPORT_INCOMPLETE_NOTICE];
  return { kind: "report", body: status.body, notices, candidate: false };
}

/** A new report (new request) may be started: nothing yet, or the last one ended without text. */
export function reportCanStart(status: ReportStatus | null | undefined) {
  return !status || reportView(status).kind === "empty";
}

/**
 * This tab's pointer to the round's report request. Display convenience only (the server owns the
 * execution): the requestId makes a retried start idempotent, the executionId re-reads the report.
 */
export type ReportRecord = { requestId: string; executionId?: string };
type RecordStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function reportRecordKey(draftId: string, roundId: string) {
  return "opc-report:" + draftId + ":" + roundId;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readReportRecord(storage: RecordStorage | null, key: string): ReportRecord | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { requestId, executionId } = value as Record<string, unknown>;
    if (typeof requestId !== "string" || !uuid.test(requestId)) return null;
    return typeof executionId === "string" && uuid.test(executionId) ? { requestId, executionId } : { requestId };
  } catch {
    return null;
  }
}

export function writeReportRecord(storage: RecordStorage | null, key: string, record: ReportRecord) {
  try {
    storage?.setItem(key, JSON.stringify(record));
  } catch {
    /* Private mode or full storage: the in-memory record still serves this page. */
  }
}

/**
 * The requestId of the next paid start. A request the server has not answered with an execution
 * (its answer was lost, or it was refused) is sent again with the same id, so a lost admission
 * can never become a second charge; a new id only after the last request has its execution.
 */
export function nextRequestId(record: ReportRecord | null, mint: () => string) {
  return record && !record.executionId ? record.requestId : mint();
}

/** The executionId `reportStart` returned, or null for an unexpected answer. */
export function startedExecution(result: unknown): string | null {
  const id = result && typeof result === "object" ? (result as { executionId?: unknown }).executionId : null;
  return typeof id === "string" && uuid.test(id) ? id : null;
}

/** What the page's `runtime.reportLatest` query said: not answered yet, failed, or the round's newest report (or none). */
export type ServerReport = { kind: "pending" } | { kind: "failed" } | { kind: "known"; executionId: string | null };

/**
 * Generations order a pin against reads: each pin and each explicit `reportLatest` read takes the
 * next number from one counter, the read before its request is sent. So a read that started
 * before a start can never pass for a read made after it, however late it answers.
 */
export type ReportPin = { executionId: string; generation: number };
export type FreshRead = { executionId: string | null; generation: number };

/** Keep the newer of two explicit reads; a late answer of an older read never replaces a newer one. */
export function newerRead(current: FreshRead | null, next: FreshRead): FreshRead {
  return current && current.generation >= next.generation ? current : next;
}

/**
 * The report this page shows. The server is the authority, so a cleared storage or another device
 * still finds it. An execution this page just started is shown until a read that started after it
 * names another report (a replacement made in another tab); a read that started earlier, or one
 * that finds none yet, keeps the pin. The local pointer only stands in while the server cannot be read.
 */
export function shownExecution(pin: ReportPin | null, server: ServerReport, local: ReportRecord | null,
  fresh: FreshRead | null = null): string | null {
  if (pin) return fresh && fresh.executionId && fresh.generation > pin.generation ? fresh.executionId : pin.executionId;
  if (server.kind === "known") return server.executionId;
  return local?.executionId ?? null;
}

/**
 * A stream that ended with the execution still unfinished on the server (an ambiguous failure
 * answers `pending` and leaves it `interrupted`): attach to the same execution again later.
 */
export function needsReattach(result: { state?: unknown } | null | undefined) {
  return result?.state === "pending" || result?.state === "interrupted";
}

/**
 * Which paid start the page offers, if any. Never while the server read is unknown or failed,
 * never over a report that exists, runs or waits for credits: only for a round without a report
 * (`start`) or after the last one ended with no text (`restart`, a new request).
 */
export function generationOffer(input: {
  canGenerate: boolean; working: boolean; server: ServerReport; executionId: string | null; status: ReportStatus | null;
}): "start" | "restart" | null {
  if (!input.canGenerate || input.working || input.server.kind !== "known") return null;
  if (!input.executionId) return "start";
  return input.status && input.status.executionId === input.executionId && reportCanStart(input.status) ? "restart" : null;
}

/**
 * Re-attach delays after the stream could not be opened (the request may never have reached the
 * server). Bounded; each attach is the same execution, which the server replays, never a new run.
 */
export const ATTACH_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];
export function attachRetryDelay(attempt: number) {
  return ATTACH_RETRY_DELAYS_MS[attempt] ?? null;
}
