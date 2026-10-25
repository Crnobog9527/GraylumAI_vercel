/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import {
  confirmationInput, refreshInput, evidenceInput, confirmResearchCard, createResearchRefresh,
  researchToolCharges, researchEvidence, researchCards, researchBenchmarks, researchShortfall, chooseShortfall, shortfallChoiceInput,
  researchUnfinishedRound,
} from '../services/research/runtime/userApi';

export const researchRouter = router({
  cards: protectedProcedure.input(z.object({ sessionId: z.string().uuid() }).strict()).query(({ ctx, input }) =>
    researchCards(ctx.supabaseAdmin, ctx.profileId, input.sessionId)),
  benchmarks: protectedProcedure.input(z.object({ sessionId: z.string().uuid() }).strict()).query(({ ctx, input }) =>
    researchBenchmarks(ctx.supabaseAdmin, ctx.profileId, input.sessionId)),
  shortfall: protectedProcedure.input(z.object({ sessionId: z.string().uuid() }).strict()).query(({ ctx, input }) =>
    researchShortfall(ctx.supabaseAdmin, ctx.profileId, input.sessionId)),
  unfinishedRound: protectedProcedure.input(z.object({ sessionId: z.string().uuid() }).strict()).query(({ ctx, input }) =>
    researchUnfinishedRound(ctx.supabaseAdmin, ctx.profileId, input.sessionId)),
  chooseShortfall: protectedProcedure.input(shortfallChoiceInput).mutation(({ ctx, input }) =>
    chooseShortfall(ctx.supabaseAdmin, ctx.profileId, input)),
  confirmCard: protectedProcedure.input(confirmationInput).mutation(({ ctx, input }) =>
    confirmResearchCard(ctx.supabaseAdmin, ctx.profileId, input)),
  createRefresh: protectedProcedure.input(refreshInput).mutation(({ ctx, input }) =>
    createResearchRefresh(ctx.supabaseAdmin, ctx.profileId, input)),
  toolCharges: protectedProcedure.input(z.object({ transactionId: z.string().uuid() }).strict()).query(({ ctx, input }) =>
    researchToolCharges(ctx.supabaseAdmin, ctx.profileId, input.transactionId)),
  evidence: protectedProcedure.input(evidenceInput).query(({ ctx, input }) =>
    researchEvidence(ctx.supabaseAdmin, ctx.profileId, input)),
});
