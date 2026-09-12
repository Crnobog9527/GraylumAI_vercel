/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { saveVersionConflictMessage, candidateInvalidatedMessage, saveRoundClosedMessage } from "../services/artifacts/public";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { workbenchSearch, workbenchSearchInput } from "../services/research/workbenchSearch";
import { protectedProcedure, router } from "../trpc";
import { workbenchGeneration, generationQuoteInput, generationInput, generationScope, generationRecoveryInput } from "../services/artifacts/generation";
import {
  workbenchService,
  startSchema,
  webCommandSchema,
} from "../services/artifacts/workbench";
import { skillChatService, chatScope, chatEntry, chatTurnInput } from '../services/artifacts/chat';
import { artifactReuse, createWorkInput, workSourceScope } from "../services/artifacts/reuse";
const scope = z
  .object({ projectId: z.string().uuid(), roundId: z.string().uuid() })
  .strict();
// All routes (including downloads) run through the existing HTTP maintenance and Auth gates.
const procedure = protectedProcedure.use(async ({ ctx, next }) => {
  const result = await next({
    ctx: {
      ...ctx,
      skillChat: skillChatService(ctx.userScopedSupabase, ctx.hasSupabaseAdminPrivileges ? ctx.supabaseAdmin : null),
      generation: workbenchGeneration(ctx.userScopedSupabase, ctx.hasSupabaseAdminPrivileges ? ctx.supabaseAdmin : null),
      workbench: workbenchService(
        ctx.userScopedSupabase,
        ctx.hasSupabaseAdminPrivileges ? ctx.supabaseAdmin : null,
      ),
    },
  });
  if (!result.ok) {
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
      RESEARCH_DISABLED: { code: "SERVICE_UNAVAILABLE", message: "网页搜索尚未启用，仍可补充自己的参考资料。" },
      RESEARCH_BILLING_UNAVAILABLE: { code: "SERVICE_UNAVAILABLE", message: "搜索结算暂不可用，请保留本次记录后重试。" },
      RESEARCH_SCOPE_UNAVAILABLE: { code: "CONFLICT", message: "当前步骤状态已变化，请刷新后再搜索。" },
      SUMMARY_MODEL_NOT_CONFIGURED: { code: "SERVICE_UNAVAILABLE", message: "整理模型尚未配置或不可用，请联系管理员检查。已有成果保持不变。" },
      SUMMARY_MODEL_MUST_DIFFER: { code: "SERVICE_UNAVAILABLE", message: "整理模型必须与对话模型不同，请在后台调整。" },
      SUMMARY_OUTPUT_LIMIT_INVALID: { code: "SERVICE_UNAVAILABLE", message: "整理输出上限配置无效，未调用整理模型。" },
      SUMMARY_REPLY_UNAVAILABLE: { code: "CONFLICT", message: "对应回复尚未完成或来源已变化，暂不能整理。" },
      GENERATION_DISABLED: { code: "SERVICE_UNAVAILABLE", message: "AI 生成尚未启用，仍可编辑和保存内容。" },
      GENERATION_UNSUPPORTED_MODEL: { code: "SERVICE_UNAVAILABLE", message: "当前模型尚未通过工作台容量与计费配置校验。" },
      SUMMARY_INPUT_CAPACITY: { code: "BAD_REQUEST", message: "已有方法和对话超过整理模型容量，未发起本次模型调用。" },
      GENERATION_CAPACITY: { code: "BAD_REQUEST", message: "完整方法和项目内容超过当前模型容量，未扣费。" },
      GENERATION_QUOTE_CHANGED: { code: "CONFLICT", message: "内容或服务状态已变化，本次未发送，请重试。" },
      GENERATION_CONFLICT: { code: "CONFLICT", message: "生成状态或输入已变化，请刷新生成记录。不会自动重复调用模型。" },
      GENERATION_INPUT_UNAVAILABLE: { code: "BAD_REQUEST", message: "工作稿的来源或依赖已变化，请检查来源、重新保存工作稿并确认依赖后再生成。" },
      GENERATION_BUDGET: { code: "BAD_REQUEST", message: "生成费用超出允许范围，未扣费。" },
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
export const workbenchRouter = router({
  createWork: procedure.input(createWorkInput).mutation(({ctx,input})=>artifactReuse(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null).create(input)),
  workSource: procedure.input(workSourceScope).query(({ctx,input})=>artifactReuse(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null).source(input)),
  referenceChoices: procedure.input(z.object({sourceVersionId:z.string().uuid()}).strict()).query(({ctx,input})=>artifactReuse(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null).choices(input.sourceVersionId)),
  // Route one owned conversation without loading history-wide message/credit
  // statistics. The subsequent Skill/ordinary reads retain their own gates.
  chatLocate: procedure.input(chatScope).query(async ({ ctx, input }) => {
    const { data, error } = await ctx.userScopedSupabase.from('conversations')
      .select('id,module_id,skill_mode,agent_slice_mode').eq('id',input.conversationId)
      .eq('user_id',ctx.profileId).eq('is_deleted','false').single();
    if (error || !data) throw new Error('ARTIFACT_DENIED');
    return z.object({id:z.string().uuid(),module_id:z.string().uuid().nullable(),skill_mode:z.boolean().nullable(),agent_slice_mode:z.boolean()}).parse(data);
  }),
  cancelSearch: procedure.input(workbenchSearchInput).mutation(({ctx,input})=>workbenchSearch(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null).cancel(input)),
  search: procedure.input(workbenchSearchInput).mutation(({ctx,input})=>workbenchSearch(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null).search(input)),
  chatMode: procedure.input(z.object({moduleId:z.string().uuid()}).strict()).query(({ctx,input})=>ctx.skillChat.mode(input.moduleId)),
  chatEnter: procedure.input(chatEntry).mutation(({ ctx, input }) => ctx.skillChat.enter(input)),
  chatDismissSummary: procedure.input(chatScope.extend({candidateId:z.string().uuid()})).mutation(({ctx,input}) => ctx.skillChat.dismissSummary(input)),
  chatSummary: procedure.input(chatScope.extend({requestId: z.string().uuid()})).mutation(({ctx,input}) => ctx.skillChat.summary(input)),
  chatRead: procedure.input(chatScope).query(({ ctx, input }) => ctx.skillChat.read(input)),
  chatOpen: procedure.input(chatScope).query(async ({ ctx, input }) => {
    const chat = await ctx.skillChat.read(input);
    const [snapshot, rounds] = await Promise.all([
      ctx.workbench.read(chat.binding.projectId, chat.binding.roundId),
      ctx.workbench.rounds(chat.binding.projectId),
    ]);
    return { chat, snapshot, rounds };
  }),
  chatSelect: procedure.input(chatScope.extend({stepId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)}).strict()).mutation(({ ctx, input }) => ctx.skillChat.select(input)),
  chatSubmit: procedure.input(chatTurnInput).mutation(({ ctx, input }) => ctx.skillChat.submit(input)),
  generationQuote: procedure.input(generationQuoteInput).mutation(({ ctx, input }) => ctx.generation.quote(input)),
  generate: procedure.input(generationInput).mutation(({ ctx, input }) => ctx.generation.generate(input)),
  generations: procedure.input(generationScope).query(({ ctx, input }) => ctx.generation.list(input)),
  cancelGeneration: procedure.input(generationScope.extend({ requestId: z.string().uuid() }).strict()).mutation(({ ctx, input }) => ctx.generation.cancel(input)),
  abandonGeneration: procedure.input(generationScope.extend({ requestId: z.string().uuid() }).strict()).mutation(({ ctx, input }) => ctx.generation.abandon(input)),
  recoverGeneration: procedure.input(generationRecoveryInput).mutation(({ ctx, input }) => ctx.generation.recover(input)),
  catalog: procedure.input(z.object({moduleId:z.string().uuid()}).strict().optional()).query(({ ctx,input }) => ctx.workbench.catalog(input?.moduleId)),
  projects: procedure.query(({ ctx }) => ctx.workbench.projects()),
  rounds: procedure
    .input(z.object({ projectId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.workbench.rounds(input.projectId)),
  read: procedure
    .input(scope)
    .query(({ ctx, input }) =>
      ctx.workbench.read(input.projectId, input.roundId),
    ),
  report: procedure
    .input(scope)
    .query(({ ctx, input }) =>
      ctx.workbench.report(input.projectId, input.roundId),
    ),
  export: procedure
    .input(scope)
    .mutation(({ ctx, input }) =>
      ctx.workbench.export(input.projectId, input.roundId),
    ),
  start: procedure
    .input(startSchema)
    .mutation(({ ctx, input }) => ctx.workbench.start(input)),
  execute: procedure
    .input(webCommandSchema)
    .mutation(({ ctx, input }) => ctx.workbench.execute(input)),
});
