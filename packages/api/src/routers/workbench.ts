/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { RateLimitError } from '../lib/rateLimitError';
import { saveVersionConflictMessage, candidateInvalidatedMessage, saveRoundClosedMessage } from "../services/artifacts/public";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";
import {
  workbenchService,
  startSchema,
  webCommandSchema,
} from "../services/artifacts/workbench";
const scope = z
  .object({ projectId: z.string().uuid(), roundId: z.string().uuid() })
  .strict();
// All routes (including downloads) run through the existing HTTP maintenance and Auth gates.
const procedure = protectedProcedure.use(async ({ ctx, next }) => {
  const result = await next({
    ctx: {
      ...ctx,
      workbench: workbenchService(
        ctx.userScopedSupabase,
        ctx.hasSupabaseAdminPrivileges ? ctx.supabaseAdmin : null,
      ),
    },
  });
  if (!result.ok) {
    if (result.error instanceof RateLimitError) throw result.error;
    // These existing preflight errors already carry safe, actionable messages.
    if (result.error.code === 'TOO_MANY_REQUESTS' || result.error.code === 'PRECONDITION_FAILED' || result.error.code === 'FORBIDDEN' || result.error.code === 'BAD_REQUEST') throw result.error;
    const message =
      result.error.cause instanceof Error
        ? result.error.cause.message
        : result.error.message;
    const messages: Record<
      string,
      {
        code: "CONFLICT" | "FORBIDDEN" | "SERVICE_UNAVAILABLE" | "BAD_REQUEST";
        message: string;
      }
    > = {
      RESEARCH_BILLING_UNAVAILABLE: { code: "SERVICE_UNAVAILABLE", message: "搜索结算暂不可用，请保留本次记录后重试。" },
      SUMMARY_MODEL_NOT_CONFIGURED: { code: "SERVICE_UNAVAILABLE", message: "整理模型尚未配置或不可用，请联系管理员检查。已有成果保持不变。" },
      SUMMARY_MODEL_MUST_DIFFER: { code: "SERVICE_UNAVAILABLE", message: "整理模型必须与对话模型不同，请在后台调整。" },
      SUMMARY_OUTPUT_LIMIT_INVALID: { code: "SERVICE_UNAVAILABLE", message: "整理输出上限配置无效，未调用整理模型。" },
      GENERATION_CAPACITY: { code: "BAD_REQUEST", message: "完整方法和项目内容超过当前模型容量，未扣费。" },
      ARTIFACT_REFERENCE_UNAVAILABLE: {code:"CONFLICT",message:"定位来源或引用配置暂不可用，请重新查看来源。原作品已保留。"},
      ARTIFACT_ACCOUNT_CONFLICT: {
        code: "CONFLICT", message: "此账号已有另一功能的项目，暂不能在新功能中开始。请从已有项目查看历史，原成果不会被修改。",
      },
      ARTIFACT_VERSION_CONFLICT: {
        code: "CONFLICT",
        message: saveVersionConflictMessage,
      },
      ARTIFACT_SAVE_ROUND_CLOSED: { code: "CONFLICT", message: saveRoundClosedMessage },
      ARTIFACT_CANDIDATE_INVALIDATED: { code: "CONFLICT", message: candidateInvalidatedMessage },
      ARTIFACT_REVIEW_REQUIRED: {
        code: "CONFLICT",
        message: "确认状态或依赖已变化，请重新加载并复核。",
      },
      ARTIFACT_CONFLICT_OR_DENIED: {
        code: "CONFLICT",
        message: "操作未完成，请重新加载项目状态。",
      },
      ARTIFACT_DENIED: { code: "FORBIDDEN", message: "无权访问或项目不可用。" },
      ARTIFACT_EVIDENCE_UNAVAILABLE: {
        code: "FORBIDDEN",
        message: "来源已受限，报告不可导出。",
      },
      ARTIFACT_INVALID_WORKFLOW: {
        code: "BAD_REQUEST",
        message: "方法配置不可用。",
      },
    };
    throw new TRPCError(
      messages[message] ?? {
        code: "SERVICE_UNAVAILABLE",
        message: "工作台服务未配置或暂时不可用，请稍后重试。",
      },
    );
  }
  return result;
});
// LEGACY-CLOSE: the old /workbench page and its generation, search, reuse, project, round,
// report and export procedures are gone. Positioning, runtime and the module catalog use these four.
export const workbenchRouter = router({
  catalog: procedure.input(z.object({moduleId:z.string().uuid()}).strict().optional()).query(({ ctx,input }) => ctx.workbench.catalog(input?.moduleId)),
  read: procedure
    .input(scope)
    .query(({ ctx, input }) =>
      ctx.workbench.read(input.projectId, input.roundId),
    ),
  start: procedure
    .input(startSchema)
    .mutation(({ ctx, input }) => ctx.workbench.start(input)),
  execute: procedure
    .input(webCommandSchema)
    .mutation(({ ctx, input }) => ctx.workbench.execute(input)),
});
