/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * R5 report editing and 定稿 (#783 backend), without React so the rules are testable. The server owns
 * versions, completeness and the publish checks; the page keeps the user's text and explains answers.
 */
export const REPORT_MAX_CHARACTERS = 12000;

export const REPORT_DOC_TEXT = {
  edit: "修改报告",
  save: "保存修改",
  cancel: "取消修改",
  finalize: "定稿",
  finalizeConfirm: "确定定稿",
  finalizeBack: "再想想",
  finalizeAsk: "定稿后这份报告成为正式定位版本，之后不能再修改。确定定稿吗？",
  edited: "报告已手动修改",
  editedScope: "手动修改只改报告正文，不改动各步已确认的内容；选题和写作仍按各步确认的内容进行。",
  notFinalizable: "这份报告不完整（被截断、停止，或缺少报告要求的部分），不能定稿。",
  topics: "继续生成第一周选题",
  newerElsewhere: "这份报告在别处有了更新的版本。保存时会提示冲突，不会覆盖那边的修改。",
  showLatest: "查看最新保存的内容",
  closeUnsaved: "报告的修改还没有保存，关闭后会丢失。确定关闭吗？",
  loadFailed: "暂时无法读取报告的最新版本，下面显示的是生成时的内容，暂时不能修改或定稿；请稍后重新打开。",
} as const;

export const finalizedNotice = (version: number | null) =>
  version ? `报告已定稿，成为正式定位第 ${version} 版。` : "报告已定稿，成为正式定位版本。";

/** Exactly `runtime.reportDocument` / `reportSave` / `reportFinalize`. */
export type ReportDocument = {
  executionId: string;
  revision: number;
  body: string;
  bodyHash: string;
  manuallyEdited: boolean;
  completeness: string | null;
  candidate: boolean;
  finalized: boolean;
  versionId: string | null;
  version: number | null;
  next: { kind: "first_week_topics"; draftId: string; sourceVersionId: string } | null;
};

const errors: Record<string, string> = {
  REPORT_AUTH_REQUIRED: "登录状态需要重新验证，请重新登录后再试。你的修改仍保留在编辑框里。",
  REPORT_EXECUTION_REQUIRED: "找不到这份报告，请关闭后重新打开。",
  REPORT_SOURCE_CONFLICT: "确认的信息或报告来源有变化，这份报告不能定稿。请刷新页面核对。",
  REPORT_CONFIRMATION_REQUIRED: "还有步骤没有有效确认，全部确认后才能定稿。",
  REPORT_NOT_COMPLETE: REPORT_DOC_TEXT.notFinalizable,
  REPORT_EVIDENCE_CAPACITY: "这份定位的资料来源已达到 128 条上限，不能定稿。请先整理资料来源，再重新确认。",
  REPORT_BODY_INVALID: `报告内容为空或超过 ${REPORT_MAX_CHARACTERS} 字，没有保存。`,
  REPORT_VERSION_CONFLICT: "报告刚在别处被修改过，已读取最新内容。你的修改仍保留在编辑框里，核对后再保存。",
  REPORT_REQUEST_CONFLICT: "这次提交和之前的一次请求冲突，没有生效。请重新操作。",
  REPORT_ALREADY_FINALIZED: "这份报告已经定稿，不能再修改。",
  CONTENT_ERASED: "这份报告的内容已删除。",
};
export const REPORT_DOC_UNAVAILABLE = "暂时无法完成，结果还没有确认。你的修改仍保留，可以稍后再点一次，不会重复保存或重复定稿。";

/** Fixed text for a refused or lost save/定稿; server text is never shown. `known`: the server answered. */
export function reportDocumentError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  const known = Object.hasOwn(errors, code);
  return { code, text: known ? errors[code]! : REPORT_DOC_UNAVAILABLE, known };
}

/** Unicode characters, as the server counts them. */
export const reportLength = (text: string) => [...text].length;

export function canSave(doc: Pick<ReportDocument, "body" | "finalized">, text: string) {
  return !doc.finalized && text.trim().length > 0 && reportLength(text) <= REPORT_MAX_CHARACTERS && text !== doc.body;
}

export function canFinalize(doc: Pick<ReportDocument, "candidate" | "finalized">, editing: boolean) {
  return doc.candidate && !doc.finalized && !editing;
}

/**
 * One request identity per intent. Retrying the same save or 定稿 after an unknown outcome reuses the
 * request id (the server answers the same result); a different body, revision or action gets a new id.
 */
export type PendingRequest = { intent: string; requestId: string };
export function requestFor(previous: PendingRequest | null, intent: unknown[], newId: () => string): PendingRequest {
  const key = JSON.stringify(intent);
  return previous?.intent === key ? previous : { intent: key, requestId: newId() };
}

/**
 * The 定稿 question names the version on screen when it opened. A newer version (another tab, a re-read) closes
 * it, so one click can never finalize text the user did not look at; the server's hash check backs this up.
 */
export function askedVersion(asked: { revision: number; bodyHash: string } | null, doc: Pick<ReportDocument, "revision" | "bodyHash">) {
  return asked && asked.revision === doc.revision && asked.bodyHash === doc.bodyHash ? asked : null;
}

/** The save answer is this text. A replay after a lost answer returns the current version, which may be newer. */
export function savedAs(saved: Pick<ReportDocument, "body" | "manuallyEdited">, text: string) {
  return saved.manuallyEdited && saved.body === text;
}
