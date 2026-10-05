/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { STOPPED_NOTICE } from "./stop-reply";

/**
 * REPORT-GEN on the positioning page (#667 backend), without React so the rules are testable.
 * The entry follows the server switch (`runtime.reportAvailable`); membership, sources and money
 * are checked by the server, the page only explains its answer. No predicted credit cost and no
 * model names are ever shown (MASTER_PLAN §2.1 items 25, 50).
 */
export const REPORT_TITLE = "完整定位报告";
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
};

export type StartRefusal = { text: string; membership?: true; hideEntry?: true };

/** Fixed text for a refused or lost `reportStart`; server text is never shown. */
export function reportStartRefusal(cause: unknown): StartRefusal {
  const message = cause instanceof Error ? cause.message : "";
  const text = startRefusals[message];
  if (!text) return { text: REPORT_UNCONFIRMED_NOTICE };
  if (message === "REPORT_MEMBERSHIP_REQUIRED") return { text, membership: true };
  if (message === "REPORT_DISABLED") return { text, hideEntry: true };
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

/** The executionId `reportStart` returned, or null for an unexpected answer. */
export function startedExecution(result: unknown): string | null {
  const id = result && typeof result === "object" ? (result as { executionId?: unknown }).executionId : null;
  return typeof id === "string" && uuid.test(id) ? id : null;
}
