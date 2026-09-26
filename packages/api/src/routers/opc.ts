/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";
import {loadStagingPolicy,assertStagingReadAccess} from '../services/runtime/stagingPolicy';
import {StagingAccessError,stagingProcedureError,stagingRpcFailure} from '../services/runtime/stagingErrors';
import { dedupeHandoffResults } from "../services/opc/handoff-view";
import {
  opcService,
  opcStart,
  opcPlan,
  opcHandoff,
  opcGenerate,
  opcSaveResult,
  opcInformation,
  opcTopicBind,
  opcTopicTurn,
  opcTopicDraft,
  opcAdoptTopics,
  opcLibraryEdit,
  opcContentFromExecution,
  opcContentManualSave,
  opcVideoPackage,
  opcVideoResults,
  opcVideoExecutionCheck,
  opcVideoMaterialPrepare,
} from "../services/opc/service";
const procedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  let real;
  try {
    if (!ctx.supabaseAdmin || !ctx.hasSupabaseAdminPrivileges)
      throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) throw new StagingAccessError('RUNTIME_STAGING_NOT_CONFIGURED');
    const u = new URL(url);
    const local = u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password;
    if (!local) real = await loadStagingPolicy(ctx.supabaseAdmin, ctx.user.id, process.env);
  } catch (cause) { throw stagingProcedureError(cause, path); }
  const result = await next({ ctx: { ...ctx, opc: opcService(ctx.userScopedSupabase, ctx.supabaseAdmin, real) } });
  if (!result.ok) {
    // Existing bounded OPC refusal codes are part of client recovery. Preserve
    // them; typed staging/database failures and unexpected exceptions are mapped.
    const cause = result.error.cause;
    if (!(cause instanceof Error && cause.constructor === Error && /^OPC_[A-Z_]+$/.test(cause.message)))
      throw stagingProcedureError(result.error, path);
  }
  return result;
});
const readProcedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  let local = false;
  try {
    if (!ctx.supabaseAdmin || !ctx.hasSupabaseAdminPrivileges)
      throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid.local');
    local = u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password;
    if (!local) await assertStagingReadAccess(ctx.supabaseAdmin, ctx.user.id, process.env);
  } catch (cause) { throw stagingProcedureError(cause, path); }
  const result = await next({ ctx: { ...ctx, opc: opcService(ctx.userScopedSupabase, ctx.supabaseAdmin), stagingRead: !local } });
  if (!result.ok) throw stagingProcedureError(result.error, path);
  return result;
});
export const opcRouter = router({
  information: procedure
    .input(opcInformation)
    .mutation(({ ctx, input }) => ctx.opc.information(input)),
  prepareStep: procedure
    .input(opcGenerate)
    .mutation(({ ctx, input }) => ctx.opc.prepareStep(input)),
  saveResult: procedure
    .input(opcSaveResult)
    .mutation(({ ctx, input }) => ctx.opc.saveResult(input)),
  planResult: readProcedure
    .input(
      z
        .object({ draftId: z.string().uuid(), executionId: z.string().uuid() })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return {
          valid: true as const,
          ...(await ctx.opc.planResult(input.draftId, input.executionId)),
        };
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message === "OPC_PLAN_RESPONSE_INVALID"
        )
          return { valid: false as const };
        throw cause;
      }
    }),
  revise: procedure
    .input(
      z
        .object({
          draftId: z.string().uuid(),
          requestId: z.string().uuid(),
          expectedRoundId: z.string().uuid(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      ctx.opc.revise(input.draftId, input.requestId, input.expectedRoundId),
    ),
  saveWorkResult: procedure
    .input(z.object({ executionId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => ctx.opc.saveWorkResult(input.executionId)),
  workResults: readProcedure
    .input(z.object({ sessionId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.opc.workResults(input.sessionId)),
  catalog: procedure.query(async ({ ctx, path }) => {
    try { return await ctx.opc.catalog(); } catch (cause) { throw stagingProcedureError(cause, path); }
  }),
  list: readProcedure.query(({ ctx }) => ctx.opc.list()),
  conversations: readProcedure.query(async ({ ctx }) => {
    // Actor is always derived from the verified session, never supplied by input.
    const { data, error } = await ctx.supabaseAdmin.rpc('opc_free_conversations', { p_actor_id: ctx.user.id });
    if (error) stagingRpcFailure(error);
    return z.array(z.object({ sessionId: z.string().uuid(), title: z.string(), lastActivityAt: z.string() })).parse(data);
  }),
  planRequestState: readProcedure
    .input(
      z
        .object({ draftId: z.string().uuid(), requestId: z.string().uuid() })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.opc.planRequestState(input.draftId, input.requestId),
    ),
  // The bound topic workspace of the draft: binding read, the single explicit
  // bind, and one normal Agent turn inside it. All three keep their server-side
  // authorization; nothing here trusts a client-supplied session or Skill.
  topicWorkspace: readProcedure
    .input(z.object({ draftId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.opc.topicRead(input.draftId)),
  consentTopicWorkspace: procedure
    .input(opcTopicBind.omit({ requestId: true }))
    .mutation(({ ctx, input }) => ctx.opc.topicConsent(input)),
  bindTopicWorkspace: procedure
    .input(opcTopicBind)
    .mutation(({ ctx, input }) => ctx.opc.topicBind(input)),
  topicTurn: procedure
    .input(opcTopicTurn)
    .mutation(({ ctx, input }) => ctx.opc.prepareTopicTurn(input)),
  saveTopicDraft: procedure
    .input(opcTopicDraft)
    .mutation(({ ctx, input }) => ctx.opc.topicDraft(input)),
  topicDraft: readProcedure
    .input(z.object({ draftId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.opc.topicDraftRead(input.draftId)),
  adoptTopics: procedure
    .input(opcAdoptTopics)
    .mutation(({ ctx, input }) => ctx.opc.adoptTopics(input)),
  library: readProcedure
    .input(z.object({ search: z.string().max(160).default(''), from: z.string().date().nullable().default(null), to: z.string().date().nullable().default(null) }).strict())
    .query(({ ctx, input }) => ctx.opc.library(input)),
  workUiChange: procedure
    .input(z.object({workItemId:z.string().uuid(),requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),action:z.enum(['rename','pin','unpin','archive','restore','delete']),name:z.string().trim().min(1).max(160).optional()}).strict())
    .mutation(({ctx,input})=>ctx.opc.workUiChange(input)),
  accountUiChange: procedure
    .input(z.object({accountProjectId:z.string().uuid(),requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),name:z.string().trim().min(1).max(120)}).strict())
    .mutation(({ctx,input})=>ctx.opc.accountUiChange(input)),
  publicationUiChange: procedure
    .input(z.object({workItemId:z.string().uuid(),requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),plannedDate:z.string().date().nullable(),status:z.enum(['unpublished','published']),publishedDate:z.string().date().nullable()}).strict())
    .mutation(({ctx,input})=>ctx.opc.publicationUiChange(input)),
  positionHistory: readProcedure
    .input(z.object({draftId:z.string().uuid()}).strict())
    .query(({ctx,input})=>ctx.opc.positionHistory(input.draftId)),
  accountStrategyHistory: readProcedure
    .input(z.object({accountProjectId:z.string().uuid()}).strict())
    .query(({ctx,input})=>ctx.opc.accountStrategyHistory(input.accountProjectId)),
  accountStrategySchema: readProcedure
    .input(z.object({accountProjectId:z.string().uuid()}).strict())
    .query(({ctx,input})=>ctx.opc.accountStrategySchema(input.accountProjectId)),
  accountStrategyBegin: procedure
    .input(z.object({accountProjectId:z.string().uuid(),requestId:z.string().uuid()}).strict())
    .mutation(({ctx,input})=>ctx.opc.accountStrategyBegin(input.accountProjectId,input.requestId)),
  accountStrategySave: procedure
    .input(z.object({accountProjectId:z.string().uuid(),requestId:z.string().uuid(),expectedSourceVersionId:z.string().uuid(),expectedPendingDraftId:z.string().uuid().nullable(),expectedRegistrationId:z.string().min(1).max(100).nullable().optional(),expectedStepVersions:z.record(z.string().max(64),z.number().int().nonnegative()).nullable().optional(),edits:z.record(z.string().max(64),z.record(z.string().max(64),z.string().max(400)))}).strict())
    .mutation(({ctx,input})=>ctx.opc.accountStrategySave(input)),
  editLibrary: procedure
    .input(opcLibraryEdit)
    .mutation(({ ctx, input }) => ctx.opc.libraryEdit(input)),
  saveContentResult: procedure
    .input(opcContentFromExecution)
    .mutation(({ ctx, input }) => ctx.opc.contentFromExecution(input)),
  saveContentManual: procedure
    .input(opcContentManualSave)
    .mutation(({ ctx, input }) => ctx.opc.contentManualSave(input)),
  saveVideoPackage: procedure
    .input(opcVideoPackage)
    .mutation(({ ctx, input }) => ctx.opc.videoPackage(input)),
  saveVideoResults: procedure
    .input(opcVideoResults)
    .mutation(({ ctx, input }) => ctx.opc.videoResults(input)),
  checkVideoExecution: procedure
    .input(opcVideoExecutionCheck)
    .mutation(({ ctx, input }) => ctx.opc.videoExecutionCheck(input)),
  prepareVideoMaterial: procedure
    .input(opcVideoMaterialPrepare)
    .mutation(({ ctx, input }) => ctx.opc.videoMaterialPrepare(input)),
  read: readProcedure
    .input(z.object({ draftId: z.string().uuid() }).strict())
    .query(async({ ctx, input }) => dedupeHandoffResults({...await ctx.opc.read(input.draftId),runtimeMode:ctx.stagingRead?"staging_test":"isolated"})),
  start: procedure
    .input(opcStart)
    .mutation(({ ctx, input }) => ctx.opc.start(input)),
  savePlan: procedure
    .input(opcPlan)
    .mutation(({ ctx, input }) => ctx.opc.savePlan(input)),
  handoff: procedure
    .input(opcHandoff)
    .mutation(({ ctx, input }) => ctx.opc.handoff(input)),
});
