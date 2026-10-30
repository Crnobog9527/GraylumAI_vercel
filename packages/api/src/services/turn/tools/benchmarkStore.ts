/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalAccount, type CanonicalAccount } from '../../research/tools/accountLinks';
import type { CardPayload, DiscoveryRecord, FetchClaim, RuntimeResearchStore, SelectionCard, ShortfallCard } from '../../research/runtime/store';
import { stableResearchId } from '../../research/runtime/toolContext';
import type { SocialPlatform } from '../../research/vendors/types';

/*
 * CORE-PATH-V2 V2-5c (Owner 10-30 option A): the benchmark flow's store on the turn core. The flow's code is unchanged; everything
 * it reads came from the one read before the turn (mentor_turn_prepare), and everything it writes stays here until turn_close
 * hands `journal()` to research_turn_apply. Nothing touches the database between model calls. Ids are chosen here, so a repeated
 * close writes nothing twice. Rules mirror the SQL functions they stand in for; research_turn_apply runs their checks again.
 */
const uuid = z.string().uuid();
const operation = z.object({ id: uuid, identityHash: z.string(), state: z.string(), result: z.record(z.string(), z.unknown()).nullable(),
  quoteUnits: z.number().optional(), discoveryId: uuid.nullable().optional() });
export const preparedResearch = z.object({
  cards: z.array(z.object({ cardId: uuid, kind: z.enum(['keywords', 'candidates']), options: z.array(z.record(z.string(), z.unknown())),
    minSelect: z.number(), maxSelect: z.number(), confirmationId: uuid.nullable(), items: z.array(z.unknown()).nullable() })).default([]),
  cardDiscoveries: z.record(z.string(), uuid).default({}),
  fetches: z.array(z.object({ id: uuid, attempt: uuid, platform: z.string(), account: z.string(), state: z.string(),
    evidence: z.record(z.string(), z.unknown()).nullable() })).default([]),
  discoveries: z.array(z.object({ discoveryId: uuid, keywords: z.array(z.string()), platforms: z.array(z.string()),
    cursor: z.record(z.string(), z.unknown()), state: z.enum(['running', 'completed']), keywordConfirmationId: uuid })).default([]),
  operations: z.array(operation).default([]),
  // Batches of a turn that ended before applying them: each is a list of operations.
  unapplied: z.array(z.array(operation)).default([]),
  shortfall: z.object({ rounds: z.number(), qualified: z.number(), card: z.object({ cardId: uuid, choice: z.enum(['continue', 'generate']).nullable(),
    chosenRounds: z.number().nullable().optional() }).passthrough().nullable() }).passthrough().nullable().default(null),
});
export type PreparedResearch = z.infer<typeof preparedResearch>;
type Operation = z.infer<typeof operation>;
type Fetch = { id: string; attempt: string; platform: string; account: string; state: string; evidence: Record<string, unknown> | null };

const REQUIRED_QUALIFIED = 3, MIN_ROUNDS = 2;
const accountKey = (platform: string, account: string) => `${platform}:${account.toLowerCase()}`;

export function turnResearchStore(input: { actorId: string; sessionId: string; requestId: string; text: string; prepared: PreparedResearch }) {
  const { prepared, actorId, sessionId, requestId } = input;
  const same = (other: { userId: string; sessionId: string }) => other.userId === actorId && other.sessionId === sessionId;
  const confirmed = (id: string, kind: 'keywords' | 'candidates') => prepared.cards.find(c => c.confirmationId === id && c.kind === kind);
  const accounts = (items: unknown[]): CanonicalAccount[] => items.flatMap(item => {
    const value = item as { platform?: SocialPlatform; account?: string };
    const account = value.platform && value.account ? canonicalAccount(value.platform, value.account) : null;
    return account ? [{ platform: value.platform!, account }] : [];
  });
  const known = new Map<string, Operation>(prepared.operations.map(o => [o.id, o]));
  const fresh = new Map<string, Operation>();
  for (const batch of prepared.unapplied) for (const o of batch) if (!known.has(o.id)) { known.set(o.id, o); fresh.set(o.id, o); }
  const tokens = new Map<string, Operation>(), cards = new Map<string, { kind: string; card: SelectionCard; payload: CardPayload }>();
  const fetches = new Map<string, Fetch>(prepared.fetches.map(f => [accountKey(f.platform, f.account), f]));
  const touched = new Set<string>(), shortfalls = new Set<string>();
  const discoveries = new Map<string, DiscoveryRecord & { keywordConfirmationId: string }>();
  for (const d of prepared.discoveries) discoveries.set(d.discoveryId, { ...d, platforms: d.platforms as SocialPlatform[] });
  const savedDiscoveries = new Set<string>();
  let completedRounds = 0, newlyQualified = 0;

  const evidence = (discoveryId?: string) => ({
    async open(id: string, identityHash: string, quoteUnits: number) {
      const record = { id, identityHash, state: 'prepared', result: null, quoteUnits, discoveryId: discoveryId ?? null };
      tokens.set(id, record);
      return { token: id };
    },
    dispatch: async () => true,
    async finish(id: string, _token: string, state: string, result: unknown) {
      const record = { ...tokens.get(id)!, state, result: result as Record<string, unknown> };
      known.set(id, record); fresh.set(id, record);
    },
    link: async () => {},
    async cancel(id: string) { tokens.delete(id); },
  });

  const store: RuntimeResearchStore = {
    authorization: {
      keywordConfirmation: async (other, id) => {
        const card = same(other) ? confirmed(id, 'keywords') : undefined;
        return card?.items ? { keywords: card.items as string[] } : null;
      },
      candidateConfirmation: async (other, id) => {
        const card = same(other) ? confirmed(id, 'candidates') : undefined;
        return card?.items ? accounts(card.items) : null;
      },
      userMessage: async (other, id) => same(other) && id === requestId ? input.text : null,
      refreshGrant: async () => null,
    },
    evidence,
    cancelUnsentPlan: async () => {},
    readOperation: async id => {
      const o = known.get(id);
      return o ? { identityHash: o.identityHash, state: o.state as never, result: o.result } : null;
    },
    readPlan: async () => null,
    readCard: async id => cards.get(id)?.card ?? null,
    async createCard(id, payload) {
      const selectable = payload.kind === 'keywords' ? payload.options.length : payload.options.filter(o => o.selectable === true).length;
      const card: SelectionCard = { cardId: id, kind: payload.kind, options: payload.options,
        minSelect: payload.kind === 'keywords' ? 1 : Math.min(selectable, payload.minSelect ?? 3),
        maxSelect: payload.kind === 'keywords' ? 10 : Math.min(selectable, 5) };
      cards.set(id, { kind: payload.kind, card, payload });
      return card;
    },
    confirmCard: async () => { throw new Error('RESEARCH_SCOPE_DENIED'); },
    async offerShortfall(cardId) {
      const prior = prepared.shortfall;
      const rounds = (prior?.rounds ?? 0) + completedRounds, qualified = (prior?.qualified ?? 0) + newlyQualified;
      if (prior?.card && (prior.card.choice === null || prior.card.choice === 'generate')) return null;
      if (qualified < 1 || qualified >= REQUIRED_QUALIFIED || rounds < MIN_ROUNDS
        || (prior?.card && rounds <= (prior.card.chosenRounds ?? 0))) return null;
      shortfalls.add(cardId);
      return { cardId, required: REQUIRED_QUALIFIED, offeredQualified: qualified, offeredRounds: rounds, choice: null,
        confirmationId: null } satisfies ShortfallCard;
    },
    async discoveryStart(confirmationId, platforms) {
      for (const d of discoveries.values()) if (d.keywordConfirmationId === confirmationId) return d;
      const card = confirmed(confirmationId, 'keywords');
      if (!card?.items) throw new Error('RESEARCH_NOT_CONFIRMED');
      // Stable for this confirmation: a crashed turn's paid searches are found again by their operation ids.
      const record = { discoveryId: stableResearchId(sessionId, confirmationId), keywords: card.items as string[], platforms, cursor: {},
        state: 'running' as const, keywordConfirmationId: confirmationId };
      discoveries.set(record.discoveryId, record);
      savedDiscoveries.add(record.discoveryId);
      return record;
    },
    discoveryRead: async id => discoveries.get(id) ?? null,
    sessionKeywords: async () => [...new Set(prepared.cards.filter(c => c.kind === 'keywords' && c.items)
      .flatMap(c => c.items as string[]))].slice(0, 40),
    async discoverySave(id, cursor, state) {
      const record = discoveries.get(id);
      if (!record) throw new Error('RESEARCH_SCOPE_DENIED');
      const next = { ...record, cursor, state };
      discoveries.set(id, next); savedDiscoveries.add(id);
      if (state === 'completed' && record.state !== 'completed') completedRounds++;
      return next;
    },
    async selectedAccounts(discoveryId) {
      return accounts(prepared.cards.filter(c => c.kind === 'candidates' && c.items && prepared.cardDiscoveries[c.cardId] === discoveryId)
        .flatMap(c => c.items as unknown[]));
    },
    async fetchClaim(platform, account): Promise<FetchClaim> {
      const key = accountKey(platform, account), found = fetches.get(key);
      if (found && (found.state === 'in_progress' || (found.state !== 'prepared' && (found.evidence || found.state !== 'failed'))))
        return { claimed: false, fetchId: found.id, state: found.state as never, evidence: found.evidence };
      const next = { id: found?.id ?? randomUUID(), attempt: randomUUID(), platform, account, state: 'in_progress', evidence: null };
      fetches.set(key, next);
      return { claimed: true, fetchId: next.id, attempt: next.attempt };
    },
    fetchResume: async () => null,
    fetchDispatch: async () => true,
    async fetchFinish(fetchId, attempt, state, value) {
      for (const [key, f] of fetches) if (f.id === fetchId && f.attempt === attempt) {
        // Only an attempt that ended is written: a claim the budget stopped before sending leaves nothing.
        fetches.set(key, { ...f, state, evidence: value }); touched.add(key);
        const qualified = (value?.classification as { qualified?: unknown } | undefined)?.qualified === true;
        if (state === 'succeeded' && qualified) newlyQualified++;
      }
    },
    refreshCreate: async () => { throw new Error('RESEARCH_REFRESH_INVALID'); },
    callCharge: async () => null,
  };

  return { store,
    /** The operations this batch settled, kept in its receipt so a crash does not lose paid results. */
    operations: () => [...fresh.values()],
    /** What research_turn_apply writes at close; undefined when the turn made nothing. */
    journal() {
      const pasted = (f: Fetch) => [...fresh.values()].some(o => {
        const r = o.result as { args?: { source?: { kind?: string } }; call?: { platform?: string } } | null;
        return r?.args?.source?.kind === 'user_message' && r.call?.platform === f.platform;
      });
      const out = { cards: [...cards].map(([id, c]) => ({ id, payload: c.payload })),
        discoveries: [...savedDiscoveries].map(id => { const d = discoveries.get(id)!;
          return { id, keywordConfirmationId: d.keywordConfirmationId, platforms: d.platforms, cursor: d.cursor, state: d.state }; }),
        operations: [...fresh.values()], fetches: [...touched].map(key => { const f = fetches.get(key)!;
          return { ...f, pasted: pasted(f) }; }), shortfalls: [...shortfalls].map(id => ({ id })) };
      return Object.values(out).some(list => list.length) ? out : undefined;
    } };
}
