/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { CASE_INSENSITIVE, canonicalAccount, type CanonicalAccount } from '../../research/tools/accountLinks';
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
  refresh: z.object({ platform: z.string(), account: z.string(), used: z.boolean() }).nullable().default(null),
  shortfall: z.object({ rounds: z.number(), qualified: z.number(), card: z.object({ cardId: uuid, choice: z.enum(['continue', 'generate']).nullable(),
    chosenRounds: z.number().nullable().optional() }).passthrough().nullable() }).passthrough().nullable().default(null),
});
export type PreparedResearch = z.infer<typeof preparedResearch>;
type Operation = z.infer<typeof operation>;
type Fetch = { id: string; attempt: string; platform: string; account: string; state: string; evidence: Record<string, unknown> | null };

const REQUIRED_QUALIFIED = 3, MIN_ROUNDS = 2;
const FETCH_KINDS = ['account_profile', 'account_posts', 'account_relation', 'post_detail'];
/** The account as research_account_key compares it: only some platforms ignore case. */
const sameCase = (platform: string, account: string) => CASE_INSENSITIVE.has(platform as SocialPlatform) ? account.toLowerCase() : account;
const accountKey = (platform: string, account: string) => `${platform}:${sameCase(platform, account)}`;

export function turnResearchStore(input: { actorId: string; sessionId: string; requestId: string; text: string; prepared: PreparedResearch;
  /** The user's Refresh this turn answers; prepared.refresh is its grant. */
  refreshId?: string }) {
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
  const touched = new Set<string>(), shortfalls = new Set<string>(), refreshed = new Map<string, string>();
  const discoveries = new Map<string, DiscoveryRecord & { keywordConfirmationId: string }>();
  for (const d of prepared.discoveries) discoveries.set(d.discoveryId, { ...d, platforms: d.platforms as SocialPlatform[] });
  const savedDiscoveries = new Set<string>();
  let completedRounds = 0, newlyQualified = 0;

  // A fetch this turn made for a link the user pasted: the operation that asked for this very account says so.
  const pasted = (f: Fetch) => [...fresh.values()].some(o => {
    const r = o.result as { args?: { source?: { kind?: string } }; call?: { platform?: string; query?: string } } | null;
    return r?.args?.source?.kind === 'user_message' && r.call?.platform === f.platform
      && r.call.query !== undefined && sameCase(f.platform, r.call.query) === sameCase(f.platform, f.account);
  });
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
      refreshGrant: async (other, id) => {
        const grant = same(other) && id === input.refreshId ? prepared.refresh : null;
        if (!grant) return null;
        const account = canonicalAccount(grant.platform as SocialPlatform, grant.account);
        return account ? { platform: grant.platform as SocialPlatform, account, used: grant.used } : null;
      },
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
      // As research_benchmark_rounds: one turn is one round, whether it finished a discovery or checked pasted links.
      const checked = [...touched].some(key => { const f = fetches.get(key)!; return f.state === 'succeeded' && pasted(f); });
      const rounds = (prior?.rounds ?? 0) + (completedRounds > 0 || checked ? 1 : 0), qualified = (prior?.qualified ?? 0) + newlyQualified;
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
    async fetchClaim(platform, account, refreshId): Promise<FetchClaim> {
      const key = accountKey(platform, account), found = fetches.get(key);
      // A refresh may replace a finished fetch, once; an attempt the supplier charged for and failed is never resent.
      if (refreshId && (!found || found.state === 'failed_charged')) throw new Error('RESEARCH_REFRESH_INVALID');
      if (found && (found.state === 'in_progress' || (!refreshId && found.state !== 'prepared' && (found.evidence || found.state !== 'failed'))))
        return { claimed: false, fetchId: found.id, state: found.state as never, evidence: found.evidence };
      if (refreshId) refreshed.set(key, refreshId);
      // Derived, not random: a turn that crashed after paying for this attempt gets the same ids, so its receipts answer (benchmarkFetch).
      const id = found?.id ?? stableResearchId(sessionId, platform, sameCase(platform, account));
      const attempt = stableResearchId(id, found?.attempt ?? 'first');
      fetches.set(key, { id, attempt, platform, account, state: 'in_progress', evidence: null });
      const paid = FETCH_KINDS.some(kind => known.has(stableResearchId(id, attempt, kind)));
      return { claimed: true, fetchId: id, attempt, ...(paid ? { resumed: true as const } : {}) };
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
    /** Whether these arguments name a round that finished: its operations were not read, so it must not run again. */
    finishedRound(args: { discoveryId?: unknown; keywordConfirmationId?: unknown }) {
      return [...discoveries.values()].some(d => d.state === 'completed'
        && (d.discoveryId === args.discoveryId || d.keywordConfirmationId === args.keywordConfirmationId));
    },
    /** What research_turn_apply writes at close; undefined when the turn made nothing. */
    journal() {
      const out = { cards: [...cards].map(([id, c]) => ({ id, payload: c.payload })),
        discoveries: [...savedDiscoveries].map(id => { const d = discoveries.get(id)!;
          return { id, keywordConfirmationId: d.keywordConfirmationId, platforms: d.platforms, cursor: d.cursor, state: d.state }; }),
        operations: [...fresh.values()],
        fetches: [...touched].map(key => { const f = fetches.get(key)!;
          return { ...f, pasted: pasted(f), ...(refreshed.has(key) ? { refreshId: refreshed.get(key) } : {}) }; }),
        shortfalls: [...shortfalls].map(id => ({ id })) };
      return Object.values(out).some(list => list.length) ? out : undefined;
    } };
}
