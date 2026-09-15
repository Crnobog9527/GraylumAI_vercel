/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";
import {
  opcService,
  opcStart,
  opcPlan,
  opcHandoff,
  opcGenerate,
  opcSaveResult,
  opcInformation,
} from "../services/opc/service";
const procedure = protectedProcedure.use(async ({ ctx, next }) => {
  // This batch is a local business acceptance surface. No remote database or provider.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !ctx.supabaseAdmin || !ctx.hasSupabaseAdminPrivileges)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "当前工作空间尚未开放。",
    });
  const u = new URL(url);
  if (u.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(u.hostname))
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "当前工作空间尚未开放。",
    });
  return next({
    ctx: { ...ctx, opc: opcService(ctx.userScopedSupabase, ctx.supabaseAdmin) },
  });
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
  planResult: procedure
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
  workResults: procedure
    .input(z.object({ sessionId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.opc.workResults(input.sessionId)),
  catalog: procedure.query(({ ctx }) => ctx.opc.catalog()),
  list: procedure.query(({ ctx }) => ctx.opc.list()),
  read: procedure
    .input(z.object({ draftId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => ctx.opc.read(input.draftId)),
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
