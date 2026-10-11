/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { trpc } from "@/trpc/client";

/**
 * A flow that writes a full report (`workflow.reportGeneration`, a read-only flag) becomes official through
 * 生成完整报告 → 定稿 (R5). Its old 「确认正式定位」 publish is refused by the server, so the page hides it and
 * says what to do instead. A flow without a report keeps the old publish unchanged.
 */
export const reportPublishes = (workflow: { reportGeneration?: boolean } | undefined) => workflow?.reportGeneration === true;

export const REPORT_FLOW_TEXT = {
  next: "下一步是生成完整报告：点下方「生成完整报告」，报告写完后核对、需要时修改，点「定稿」后成为正式定位；之后会单独问你是否生成第一周选题。",
  footnote: "所有步骤确认后生成完整报告，报告定稿后保存为正式定位；生成选题将在下一步单独确认。",
  /** The server's report switch is off (or unknown): no 生成完整报告 entry is shown, so none is promised. */
  unavailable: "这个定位流程要先生成完整报告并定稿，才能成为正式定位；完整报告暂未开放，已确认的内容都会保留。",
} as const;

/**
 * The guidance line of a report flow. It follows the server switch (`runtime.reportAvailable`, the same read the
 * report entry uses): it only points at 「生成完整报告」 while that entry can be shown.
 */
export function ReportFlowNotice({ kind }: { kind: "next" | "footnote" }) {
  const available = trpc.runtime.reportAvailable.useQuery(undefined, { staleTime: 60_000 });
  return <>{available.data?.enabled === true ? REPORT_FLOW_TEXT[kind] : REPORT_FLOW_TEXT.unavailable}</>;
}

/** The footer line under the publish actions: the old wording for a flow without a report. */
export function PublishFootnote({ workflow }: { workflow: { reportGeneration?: boolean } | undefined }) {
  return reportPublishes(workflow) ? <ReportFlowNotice kind="footnote" /> : <>确认后保存为正式定位；生成选题将在下一步单独确认。</>;
}

/** The last step's "what next" line once every step is confirmed: the old wording for a flow without a report. */
export function PublishNext({ workflow }: { workflow: { reportGeneration?: boolean } | undefined }) {
  return reportPublishes(workflow) ? <ReportFlowNotice kind="next" />
    : <>下一步是确认正式定位：发布定位本身不会调用模型；发布后你会被明确询问是否继续生成第一周选题，只有你选择继续时才会调用模型并按额度计费。</>;
}
