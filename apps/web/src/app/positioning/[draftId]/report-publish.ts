/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * A flow that writes a full report (`workflow.reportGeneration`, a read-only flag) becomes official through
 * 生成完整报告 → 定稿 (R5). Its old 「确认正式定位」 publish is refused by the server, so the page hides it and
 * says what to do instead. A flow without a report keeps the old publish unchanged.
 */
export const reportPublishes = (workflow: { reportGeneration?: boolean } | undefined) => workflow?.reportGeneration === true;

export const REPORT_FLOW_TEXT = {
  next: "下一步是生成完整报告：点下方「生成完整报告」，报告写完后核对、需要时修改，点「定稿」后成为正式定位；之后会单独问你是否生成第一周选题。",
  footnote: "所有步骤确认后生成完整报告，报告定稿后保存为正式定位；生成选题将在下一步单独确认。",
} as const;
