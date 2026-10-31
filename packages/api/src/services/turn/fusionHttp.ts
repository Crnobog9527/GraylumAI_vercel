/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { swallow } from '../../lib/swallow';
import { assertCompareAllowed } from '../fusion/compareAdmission';
import { compareSkillInput, loadCompareTurnParts } from '../fusion/compareLoad';
import { workspaceDependencies } from '../fusion/compareSnapshot';
import { readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { readAdmissionConfiguration } from '../runtime/admissionConfiguration';
import { rowFor } from '../runtime/settingsRows';
import { TurnStop } from './call';
import { CORE_PATH_SETTING, type ChatDeps } from './chat';
import { COMPARE_HISTORY_ITEMS, runCompareTurn } from './compare';
import { priceCompareColumns } from './compareQuote';
import { TurnDatabaseError } from './db';
import { fusionAdmission, fusionCoreSetting } from './fusionCalls';
import { fusionQuote } from './fusionQuote';
import { codeOf, juryTurn } from './jury';
import { QuoteError } from './quote';
import { eventStream } from './sse';

/*
 * CORE-PATH-V2 V2-7b: the two requests a page makes around a compare or a jury. POST /api/turn/estimate prices one, creating
 * nothing and calling no model, for the "最多消耗 X 积分" the user agrees to (the old estimates' fields). POST /api/turn/compare
 * starts a compare with the quote the user saw (`shown`): the turn may not freeze more, in total or in any column, in credits
 * or in provider cost (assertQuoteCovers). Both pass the entry checks of POST /api/turn.
 */
const uuid = z.string().uuid();
const compareFields = { sessionId: uuid, question: z.string().trim().min(1).max(20_000), modelIds: z.array(uuid).min(1).max(8),
  skill: compareSkillInput.optional() };
export const shownQuote = z.object({ credits: z.number().int().nonnegative(), columns: z.array(z.object({ modelId: uuid,
  credits: z.number().int().nonnegative(), usd: z.string().regex(/^\d+(\.\d+)?$/) }).strict()).min(1).max(8) }).strict();
export const estimateRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('compare'), ...compareFields }).strict(),
  z.object({ kind: z.literal('jury'), draftId: uuid, sourceVersionId: uuid }).strict(),
]);
export const compareStartRequest = z.object({ ...compareFields, requestId: uuid, shown: shownQuote }).strict();

export type FusionHttpDeps = {
  authenticate: (request: Request) => Promise<string | null>;
  rateLimited: (actorId: string) => Promise<boolean>;
  databaseHost: { declared: string | undefined; actual: string };
  chat: ChatDeps;
  /** The signed-in user's own client: a compare's Skill goes through the user-scoped checks of an ordinary turn. */
  userClient: (request: Request) => SupabaseClient;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const FORBIDDEN = new Set(['FUSION_COMPARE_DISABLED', 'FUSION_COMPARE_FORBIDDEN', 'FUSION_REVIEW_DISABLED', 'FUSION_MEMBERSHIP_REQUIRED',
  'REPORT_MEMBERSHIP_REQUIRED', 'TURN_MEMBERSHIP_REQUIRED', 'POSITIONING_REQUIRED']);
const UNAVAILABLE = /^TURN_(CORE_DISABLED|DATABASE_UNAVAILABLE|PROVIDER_KEY_UNAVAILABLE|PRICE_UNAVAILABLE|BILLING_UNIT_UNAVAILABLE|QUOTE_UNAVAILABLE)$/;
const refused = (code: string) => json(FORBIDDEN.has(code) ? 403 : UNAVAILABLE.test(code) ? 503 : 400, { error: code });

async function admitted(request: Request, deps: FusionHttpDeps): Promise<string | Response> {
  if (!deps.databaseHost.declared || deps.databaseHost.declared !== deps.databaseHost.actual) return json(503, { error: 'TURN_DATABASE_MISMATCH' });
  const actorId = await swallow('turn_authenticate_failed', deps.authenticate(request), null, { category: 'auth' });
  if (!actorId) return json(401, { error: 'TURN_UNAUTHENTICATED' });
  if (await swallow('turn_rate_limit_unavailable', deps.rateLimited(actorId), true, { category: 'api' })) return json(429, { error: 'TURN_RATE_LIMITED' });
  return actorId;
}

/** The compare's maximum, computed as its turn computes the freeze; the old estimate's checks, without the paid positioning judgement. */
async function compareEstimate(deps: FusionHttpDeps, request: Request, actorId: string, input: Extract<z.infer<typeof estimateRequest>, { kind: 'compare' }>) {
  const { admin, clients, pricing } = deps.chat;
  const configuration = await readAdmissionConfiguration(admin);
  const core = rowFor(configuration, CORE_PATH_SETTING);
  const setting = fusionCoreSetting.safeParse(core.error ? null : core.data?.value);
  if (!setting.success || !setting.data.enabled) throw new Error('TURN_CORE_DISABLED');
  const settings = await assertCompareAllowed(admin, actorId, input.modelIds);
  const key = await readOpenRouterKeyOrUnset(admin, { fresh: true });
  if (!key) throw new QuoteError('TURN_PROVIDER_KEY_UNAVAILABLE');
  const { sessionId, question, skill } = input;
  const parts = await loadCompareTurnParts({ admin, user: deps.userClient(request), actorId }, { sessionId, question, skill });
  const admit = await fusionAdmission(clients, actorId).compare(sessionId, COMPARE_HISTORY_ITEMS, workspaceDependencies(parts));
  if (!admit.positioned && parts.skill?.socialMedia) throw new Error('POSITIONING_REQUIRED');
  const quotes = await Promise.all(input.modelIds.map(modelId => fusionQuote(admin, { configuration, modelId, phase: 'fusion_compare',
    outputTokens: settings.answerOutputTokens, key, deps: pricing })));
  const priced = priceCompareColumns({ quotes, answerTokens: settings.answerOutputTokens, maxBudgetUsd: settings.maxBudgetUsd,
    parts: { ...parts, history: admit.history.map(m => ({ role: m.role, text: m.content })), positioningFallback: true } });
  return { credits: priced.credits, tooLarge: priced.tooLarge, overBudget: priced.overBudget,
    columns: priced.columns.map(column => ({ modelId: column.modelId, credits: column.upperCredits, usd: column.upperUsd })) };
}

export async function handleTurnEstimate(request: Request, deps: FusionHttpDeps): Promise<Response> {
  let input;
  try { input = estimateRequest.parse(await request.json()); } catch { return json(400, { error: 'TURN_REQUEST_INVALID' }); }
  const actorId = await admitted(request, deps);
  if (actorId instanceof Response) return actorId;
  try {
    if (input.kind === 'compare') return json(200, await compareEstimate(deps, request, actorId, input));
    const { admin, clients, slots, transport, pricing, newWork } = deps.chat;
    return json(200, await juryTurn({ admin, clients, slots, transport, pricing, calls: newWork.calls }, actorId)
      .estimate({ draftId: input.draftId, sourceVersionId: input.sourceVersionId }));
  } catch (error) {
    if (error instanceof TurnDatabaseError || error instanceof QuoteError || error instanceof TurnStop) return refused(error.code);
    return refused(codeOf(error));
  }
}

export async function handleCompareStart(request: Request, deps: FusionHttpDeps): Promise<Response> {
  let input;
  try { input = compareStartRequest.parse(await request.json()); } catch { return json(400, { error: 'TURN_REQUEST_INVALID' }); }
  const actorId = await admitted(request, deps);
  if (actorId instanceof Response) return actorId;
  const { sessionId, question, skill, requestId, modelIds, shown } = input;
  return eventStream(emit => runCompareTurn(deps.chat, { actorId, sessionId, requestId, modelIds, shown,
    parts: () => loadCompareTurnParts({ admin: deps.chat.admin, user: deps.userClient(request), actorId }, { sessionId, question, skill }) }, emit));
}
