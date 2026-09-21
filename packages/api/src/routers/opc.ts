/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";
import {loadStagingPolicy,assertStagingReadAccess} from '../services/runtime/stagingPolicy';
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
  opcVideoPackage,
  opcVideoExecutionCheck,
} from "../services/opc/service";
const procedure = protectedProcedure.use(async ({ ctx, next }) => {
  // Remote access requires the explicit Staging target and server-side actor window.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !ctx.supabaseAdmin || !ctx.hasSupabaseAdminPrivileges)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "当前工作空间尚未开放。",
    });
  const u = new URL(url);
  const local=u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password;
  let real;
  if(!local)try{real=await loadStagingPolicy(ctx.supabaseAdmin,ctx.user.id,process.env);}
  catch{throw new TRPCError({code:'PRECONDITION_FAILED',message:'当前工作空间尚未开放。'});}
  return next({
    ctx: { ...ctx, opc: opcService(ctx.userScopedSupabase, ctx.supabaseAdmin,real) },
  });
});
const readProcedure=protectedProcedure.use(async({ctx,next})=>{
 if(!ctx.supabaseAdmin||!ctx.hasSupabaseAdminPrivileges)throw new TRPCError({code:'PRECONDITION_FAILED'});
 const u=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL??'http://invalid.local');
 const local=u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password;
 if(!local)await assertStagingReadAccess(ctx.supabaseAdmin,ctx.user.id,process.env);
 return next({ctx:{...ctx,opc:opcService(ctx.userScopedSupabase,ctx.supabaseAdmin),stagingRead:!local}});
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
  catalog: procedure.query(({ ctx }) => ctx.opc.catalog()),
  list: readProcedure.query(({ ctx }) => ctx.opc.list()),
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
  editLibrary: procedure
    .input(opcLibraryEdit)
    .mutation(({ ctx, input }) => ctx.opc.libraryEdit(input)),
  saveContentResult: procedure
    .input(opcContentFromExecution)
    .mutation(({ ctx, input }) => ctx.opc.contentFromExecution(input)),
  saveVideoPackage: procedure
    .input(opcVideoPackage)
    .mutation(({ ctx, input }) => ctx.opc.videoPackage(input)),
  checkVideoExecution: procedure
    .input(opcVideoExecutionCheck)
    .mutation(({ ctx, input }) => ctx.opc.videoExecutionCheck(input)),
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
