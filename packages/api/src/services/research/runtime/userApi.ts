/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { RESEARCH_TOOL_NAMES, researchToolArgs } from '../tools/schemas';
import { publicHttpUrl } from '../vendors/http';
import { SOCIAL_KINDS, SOCIAL_PLATFORMS } from '../vendors/types';

interface Db {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
const id = z.string().uuid();
const optionId = z.string().regex(/^[a-z0-9]{1,8}$/);
const keyword = z.string().trim().min(1).refine(value => [...value].length <= 40 && !/\p{Cc}/u.test(value));
export const confirmationInput = z.object({
  cardId: id,
  selected: z.array(optionId).max(24),
  edits: z.record(optionId, keyword).optional(),
  additions: z.array(keyword).max(5).optional(),
}).strict();
export const refreshInput = z.object({
  sessionId: id,
  platform: z.string().regex(/^[a-z]{1,20}$/),
  account: z.string().trim().min(1).max(200).refine(value => !/\p{Cc}/u.test(value)),
}).strict();
export const evidenceInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.object({ createdAt: z.string().datetime({ offset: true }), operationId: id }).optional(),
}).strict();
const confirmationResult = z.discriminatedUnion('kind', [
  z.object({ cardId: id, confirmationId: id, kind: z.literal('keywords'), items: z.array(keyword) }),
  z.object({ cardId: id, confirmationId: id, kind: z.literal('candidates'), items: z.array(z.object({
    id: optionId, platform: z.string(), account: z.string(), evidenceRef: z.string(),
  })) }),
]);
const knownErrors = new Set([
  'RESEARCH_SCOPE_DENIED', 'RESEARCH_CARD_INVALID', 'RESEARCH_CARD_ALREADY_CONFIRMED',
  'RESEARCH_REFRESH_INVALID',
]);
async function rpc(db: Db | null, name: string, args: Record<string, unknown>) {
  if (!db) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'RESEARCH_UNAVAILABLE' });
  let response;
  try { response = await db.rpc(name, args); }
  catch { throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'RESEARCH_UNAVAILABLE' }); }
  if (response.error) {
    const message = z.object({ message: z.string() }).safeParse(response.error);
    const code = message.success && knownErrors.has(message.data.message) ? message.data.message : 'RESEARCH_UNAVAILABLE';
    throw new TRPCError({ code: code === 'RESEARCH_SCOPE_DENIED' ? 'FORBIDDEN'
      : code === 'RESEARCH_UNAVAILABLE' ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST', message: code });
  }
  return response.data;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'RESEARCH_UNAVAILABLE' });
  return result.data;
}
export async function confirmResearchCard(db: Db | null, actor: string, input: z.infer<typeof confirmationInput>) {
  const { cardId, ...submission } = confirmationInput.parse(input);
  return parse(confirmationResult, await rpc(db, 'research_card_confirm', { a: actor, p_card: cardId, p: submission }));
}
export async function createResearchRefresh(db: Db | null, actor: string, input: z.infer<typeof refreshInput>) {
  const value = refreshInput.parse(input);
  const refreshId = parse(id, await rpc(db, 'research_refresh_create', {
    a: actor, s: value.sessionId, p_platform: value.platform, p_account: value.account,
  }));
  return { refreshId };
}
const toolMetadata = z.object({ toolName: z.enum(RESEARCH_TOOL_NAMES).nullable(), args: z.unknown() });
function metadata(value: unknown) {
  const row = parse(toolMetadata, value);
  if (!row.toolName) return { toolName: null, args: null };
  const args = researchToolArgs[row.toolName].safeParse(row.args);
  // Validation must not invent omitted default arguments in the historical record.
  const original = row.args as Record<string, unknown> | null;
  return { toolName: row.toolName, args: args.success && original
    ? Object.fromEntries(Object.entries(args.data).filter(([key]) => Object.hasOwn(original, key))) : null };
}
// RT-3b PR-2 (0267): what this one subcall asked for. Rows saved before 0267, or with values outside the
// known lists, return null rather than a guess.
const callDisplay = {
  query: z.unknown().optional().transform(value => typeof value === 'string' && value.length <= 2048 ? value : null),
  platform: z.unknown().optional().transform(value =>
    typeof value === 'string' && ([...SOCIAL_PLATFORMS, 'web'] as string[]).includes(value) ? value : null),
  dataKind: z.unknown().optional().transform(value =>
    typeof value === 'string' && ([...SOCIAL_KINDS, 'web_search', 'web_fetch'] as string[]).includes(value) ? value : null),
};
const charge = z.object({
  callId: id, toolName: z.enum(RESEARCH_TOOL_NAMES).nullable(), args: z.unknown(),
  source: z.enum(['tool_usage', 'tool_no_usage', 'tool_failed', 'tool_failed_charged', 'tool_unknown']).nullable(),
  credits: z.string().regex(/^\d+(\.\d+)?$/).nullable(), ...callDisplay,
});
export async function researchToolCharges(db: Db | null, actor: string, transactionId: string) {
  const rows = parse(z.array(charge), await rpc(db, 'research_user_tool_charges', {
    a: actor, p_transaction: id.parse(transactionId),
  }));
  return { items: rows.map(row => ({ callId: row.callId, ...metadata(row), query: row.query, platform: row.platform,
    dataKind: row.dataKind, source: row.source, credits: row.credits })) };
}
const evidence = z.object({
  operationId: id, toolName: z.enum(RESEARCH_TOOL_NAMES).nullable(), args: z.unknown(),
  state: z.enum(['succeeded', 'failed', 'unknown']), fetchedAt: z.string().nullable(),
  itemCount: z.number().int().min(0).nullable(), truncated: z.boolean().nullable(),
  sources: z.array(z.string()), sessionId: id, sessionTitle: z.string().nullable(), createdAt: z.string(), ...callDisplay,
});
export async function researchEvidence(db: Db | null, actor: string, input: z.infer<typeof evidenceInput>) {
  const value = evidenceInput.parse(input);
  const rows = parse(z.array(evidence), await rpc(db, 'research_user_evidence', {
    a: actor, p_limit: value.limit + 1, p_cursor_time: value.cursor?.createdAt ?? null,
    p_cursor_id: value.cursor?.operationId ?? null,
  }));
  const hasNextPage = rows.length > value.limit;
  const items = rows.slice(0, value.limit).map(row => ({ ...row, ...metadata(row),
    sources: row.sources.filter(url => publicHttpUrl(url)),
  }));
  const last = items.at(-1);
  return { items, hasNextPage, nextCursor: hasNextPage && last
    ? { createdAt: last.createdAt, operationId: last.operationId } : null };
}

const candidate = z.object({
  id: optionId, platform: z.string(), account: z.string(), evidenceRef: z.string(),
  label: z.string().optional(), selectable: z.boolean(),
});
const card = z.discriminatedUnion('kind', [
  z.object({ cardId: id, kind: z.literal('keywords'), options: z.array(z.object({ id: optionId, text: keyword })),
    minSelect: z.number().int(), maxSelect: z.number().int(), confirmationId: id.nullable(), items: z.array(keyword).nullable() }),
  z.object({ cardId: id, kind: z.literal('candidates'), options: z.array(candidate),
    minSelect: z.number().int(), maxSelect: z.number().int(), confirmationId: id.nullable(),
    items: z.array(candidate.omit({ label: true, selectable: true })).nullable() }),
]);
export async function researchCards(db: Db | null, actor: string, sessionId: string) {
  return { items: parse(z.array(card), await rpc(db, 'research_user_cards', { a: actor, s: id.parse(sessionId) })) };
}

// RT-5: the session's benchmark table for the conversation (0282 `research_user_benchmarks`, ownership checked in
// SQL). Numbers only as the host computed them, each with the evidence refs it came from; null stays null.
const count = z.number().finite().min(0).nullable();
const refList = z.array(z.string().regex(/^[0-9a-f-]{36}#\d{1,3}$/)).max(40);
const benchmark = z.object({
  platform: z.string(), account: z.string(), followers: count, medianViews: count, engagementRate: count,
  postsPerWeek: count, lastPublishedAt: z.string().nullable(), postsAnalyzed: z.number().int().min(0),
  category: z.enum(['head_reference', 'imitable', 'fast_rising']).nullable(), qualified: z.boolean(),
  excluded: z.string().nullable(), fetchedAt: z.string(),
  refs: z.object({ followers: refList, medianViews: refList, engagementRate: refList, postsPerWeek: refList,
    lastPublishedAt: refList }),
});
export async function researchBenchmarks(db: Db | null, actor: string, sessionId: string) {
  const rows = parse(z.array(benchmark), await rpc(db, 'research_user_benchmarks', { a: actor, s: id.parse(sessionId) }));
  return { items: rows };
}

// BENCHMARK-SHORTFALL (0318, Owner 2026-10-20 choice B): the session's choice card and the user's one answer.
const shortfallCard = z.object({
  cardId: id, required: z.number().int(), offeredQualified: z.number().int(), offeredRounds: z.number().int(),
  choice: z.enum(['continue', 'generate']).nullable(), confirmationId: id.nullable(),
  chosenQualified: z.number().int().nullable(), chosenRounds: z.number().int().nullable(), chosenAt: z.string().nullable(),
});
export const shortfallChoiceInput = z.object({ cardId: id, choice: z.enum(['continue', 'generate']) }).strict();
export async function researchShortfall(db: Db | null, actor: string, sessionId: string) {
  return parse(z.object({ rounds: z.number().int(), qualified: z.number().int(), card: shortfallCard.nullable() }),
    await rpc(db, 'research_user_shortfall', { a: actor, s: id.parse(sessionId) }));
}
export async function chooseShortfall(db: Db | null, actor: string, input: z.infer<typeof shortfallChoiceInput>) {
  const value = shortfallChoiceInput.parse(input);
  return parse(shortfallCard, await rpc(db, 'research_benchmark_shortfall_choose', {
    a: actor, p_card: value.cardId, p_choice: value.choice,
  }));
}
