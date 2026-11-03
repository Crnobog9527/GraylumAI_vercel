import { archiveBusinessInput, archiveBusiness, listBusinesses } from '../services/opc/businessArchive';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { capturePendingInput, captureResolveInput } from "../services/opc/capture";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";
import {loadStagingPolicy,assertStagingReadAccess} from '../services/turn/settings/stagingPolicy';
import {StagingAccessError,stagingProcedureError,stagingRpcFailure} from '../services/turn/settings/stagingErrors';
import {topicAdoptionWithSource} from "../services/opc/dataFoundation";
import { dedupeHandoffResults } from "../services/opc/handoff-view";
import { realHostMode } from "../services/turn/settings/productionEnvironment";
import { conversationRename, renameConversation } from "../services/opc/conversationName";
import { sessionResultEdit, sessionResultFamily, sessionResultSaveTurn, sessionResultsList,
  sessionResultsService } from "../services/opc/sessionResults";
import {
  opcService,
  opcStart,
  opcPlan,
  opcHandoff,
  opcInformation,
  opcTopicBind,
  opcTopicDraft,
  opcLibraryEdit,
  opcContentFromTurn,
  opcContentManualSave,
  opcVideoResultsFromTurn,
  opcVideoMaterialPrepare,
} from "../services/opc/service";
const procedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  ctx.runtimeBudget?.timing?.enter('policy');
  let real:Awaited<ReturnType<typeof loadStagingPolicy>>|undefined;
  try {
    if (!ctx.supabaseAdmin || !ctx.hasSupabaseAdminPrivileges)
      throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) throw new StagingAccessError('RUNTIME_STAGING_NOT_CONFIGURED');
    const u = new URL(url);
    const local = u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password;
    if (!local) real = await loadStagingPolicy(ctx.supabaseAdmin, ctx.user.id, process.env);
  } catch (cause) { throw stagingProcedureError(cause, path); }
  ctx.runtimeBudget?.timing?.enter('host');
  const result = await next({ ctx: { ...ctx, opc: opcService(ctx.userScopedSupabase, ctx.supabaseAdmin, real), stagingPolicy: real } });
  if (!result.ok && !isOpcRefusal(result.error.cause)) throw stagingProcedureError(result.error, path);
  return result;
});
// Existing bounded OPC refusal codes are part of client recovery. Preserve
// them; typed staging/database failures and unexpected exceptions are mapped.
function isOpcRefusal(cause: unknown): cause is Error {
  return cause instanceof Error && cause.constructor === Error && /^OPC_[A-Z_]+$/.test(cause.message);
}
// A read of another account's (or a removed) record is refused by SQL with an OPC_*_DENIED code. For a query that
// is "not found", the same answer for both, so the reply never reveals whether the record exists.
function isOpcReadDenial(cause: unknown): boolean {
  return cause instanceof Error && cause.constructor === Error && /^OPC_(?:[A-Z]+_)*DENIED$/.test(cause.message);
}
// Reads need only read access (they stay available after generation is switched off). `keepRefusals` keeps the bounded
// OPC_* refusal codes the page maps to plain text instead of turning them into a generic server error.
const readAccess = (keepRefusals: boolean) => protectedProcedure.use(async ({ ctx, next, path, type }) => {
  ctx.runtimeBudget?.timing?.enter('policy');
  let local = false;
  try {
    if (!ctx.supabaseAdmin || !ctx.hasSupabaseAdminPrivileges)
      throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid.local');
    local = u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password;
    if (!local) await assertStagingReadAccess(ctx.supabaseAdmin, ctx.user.id, process.env);
  } catch (cause) { throw stagingProcedureError(cause, path); }
  ctx.runtimeBudget?.timing?.enter('host');
  const result = await next({ ctx: { ...ctx, opc: opcService(ctx.userScopedSupabase, ctx.supabaseAdmin), stagingRead: !local } });
  if (!result.ok && !keepRefusals && type === 'query' && isOpcReadDenial(result.error.cause))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'OPC_NOT_FOUND' });
  if (!result.ok && !(keepRefusals && isOpcRefusal(result.error.cause))) throw stagingProcedureError(result.error, path);
  return result;
});
const readProcedure = readAccess(false);
const resultReadProcedure = readAccess(true);
export const opcRouter = router({
  businesses: readProcedure.query(({ ctx }) => listBusinesses(ctx.supabaseAdmin, ctx.user.id)),
  archiveBusiness: readProcedure.input(archiveBusinessInput)
    .mutation(({ ctx, input }) => archiveBusiness(ctx.supabaseAdmin, ctx.user.id, input.businessId)),
  capturePending: readProcedure.input(capturePendingInput).mutation(({ ctx, input }) => ctx.opc.capturePending(input)),
  captureResolve: procedure.input(captureResolveInput).mutation(({ ctx, input }) => ctx.opc.captureResolve(input)),
  information: procedure
    .input(opcInformation)
    .mutation(({ ctx, input }) => ctx.opc.information(input)),
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
    .input(z.object({ turnId: z.number().int().positive() }).strict())
    .mutation(({ ctx, input }) => ctx.opc.saveWorkResult(input)),
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
  conversationRename: procedure
    .input(conversationRename)
    .mutation(({ ctx, input }) => renameConversation(ctx.supabaseAdmin, ctx.user.id, input)),
  // C1-lite: this conversation's results folder. The user confirms every write; the AI never writes here.
  sessionResults: resultReadProcedure.input(sessionResultsList)
    .query(({ ctx, input }) => sessionResultsService(ctx.supabaseAdmin, ctx.user.id).list(input)),
  sessionResultVersions: resultReadProcedure.input(sessionResultFamily)
    .query(({ ctx, input }) => sessionResultsService(ctx.supabaseAdmin, ctx.user.id).versions(input)),
  sessionResultSaveTurn: procedure.input(sessionResultSaveTurn)
    .mutation(({ ctx, input }) => sessionResultsService(ctx.supabaseAdmin, ctx.user.id).saveTurn(input)),
  sessionResultEdit: procedure.input(sessionResultEdit)
    .mutation(({ ctx, input }) => sessionResultsService(ctx.supabaseAdmin, ctx.user.id).edit(input)),
  sessionResultDelete: procedure.input(sessionResultFamily)
    .mutation(({ ctx, input }) => sessionResultsService(ctx.supabaseAdmin, ctx.user.id).remove(input)),
  // The bound topic workspace of the draft: binding read and the single explicit
  // bind. Both keep their server-side authorization; nothing here trusts a
  // client-supplied session or Skill. The topic turn itself is POST /api/turn.
  topicWorkspace: readProcedure
    .input(z.object({ draftId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.opc.topicRead(input.draftId)),
  consentTopicWorkspace: procedure
    .input(opcTopicBind.omit({ requestId: true }))
    .mutation(({ ctx, input }) => ctx.opc.topicConsent(input)),
  saveTopicDraft: procedure
    .input(opcTopicDraft)
    .mutation(({ ctx, input }) => ctx.opc.topicDraft(input)),
  topicDraft: readProcedure
    .input(z.object({ draftId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.opc.topicDraftRead(input.draftId)),
  adoptTopics: procedure
    .input(topicAdoptionWithSource)
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
  saveContentFromTurn: procedure
    .input(opcContentFromTurn)
    .mutation(({ ctx, input }) => ctx.opc.contentFromTurn(input)),
  saveContentManual: procedure
    .input(opcContentManualSave)
    .mutation(({ ctx, input }) => ctx.opc.contentManualSave(input)),
  saveVideoResultsFromTurn: procedure
    .input(opcVideoResultsFromTurn)
    .mutation(({ ctx, input }) => ctx.opc.videoResultsFromTurn(input)),
  prepareVideoMaterial: procedure
    .input(opcVideoMaterialPrepare)
    .mutation(({ ctx, input }) => ctx.opc.videoMaterialPrepare(input)),
  read: readProcedure
    .input(z.object({ draftId: z.string().uuid() }).strict())
    .query(async({ ctx, input }) => dedupeHandoffResults({...await ctx.opc.read(input.draftId),
      runtimeMode:ctx.stagingRead?realHostMode(process.env):"isolated"})),
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
