/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HOST_TURN_MAX_BYTES, hostTurnContextSchema, RESEARCH_CARDS_NOTE, type HostTurnContext } from './hostTurn';
import { researchHost, researchHostContext, withResearchContext } from './researchHostContext';
import { DEFAULT_RUNTIME_RATE_LIMITS } from './rateLimitSettings';
import type { SettingsRead } from './newWorkGate';

const actor = '10000000-0000-4000-8000-000000000001', session = '10000000-0000-4000-8000-000000000002';
const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (account: string, qualified: boolean, followers: number) => ({ platform: 'tiktok', account, followers,
  medianViews: 5000, engagementRate: 0.05, postsPerWeek: 3, lastPublishedAt: '2026-10-10T00:00:00Z', postsAnalyzed: 25,
  category: qualified ? 'imitable' : 'head_reference', qualified, excluded: null, missing: [], fetchedAt: '2026-10-16T00:00:00Z' });
const cards = [
  { cardId: uuid(1), kind: 'keywords', options: [], minSelect: 1, maxSelect: 5, confirmationId: uuid(11), items: ['家居收纳', '租房改造'] },
  { cardId: uuid(2), kind: 'keywords', options: [], minSelect: 1, maxSelect: 5, confirmationId: uuid(12), items: ['小户型'] },
  { cardId: uuid(3), kind: 'candidates', options: [], minSelect: 3, maxSelect: 5, confirmationId: uuid(13),
    items: [{ id: 'c1', platform: 'tiktok', account: 'homeideas', evidenceRef: 'e#1' }] },
  { cardId: uuid(4), kind: 'candidates', options: [], minSelect: 3, maxSelect: 5, confirmationId: null, items: null },
];
let rows: unknown[] = [];
let failing: string | null = null;
const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === failing) return { data: null, error: { message: 'boom' } };
  if (name === 'research_user_cards') return { data: cards, error: null };
  if (name === 'research_confirmation_read') return { data: { kind: 'candidates', discoveryId: uuid(99), items: [] }, error: null };
  if (name === 'research_benchmark_rows') return { data: { rows, hash: 'a'.repeat(64) }, error: null };
  throw new Error(`${name} ${JSON.stringify(args)}`);
});
const admin = { rpc } as unknown as SupabaseClient;
const settings = (researchEnabled?: boolean): Promise<SettingsRead> => Promise.resolve({ ok: true, config: { ...DEFAULT_RUNTIME_RATE_LIMITS },
  ...(researchEnabled === undefined ? {} : { researchEnabled }) });
const base: HostTurnContext = { stepId: 'step-2', opening: false, checklist: [] };

beforeEach(() => { failing = null; rows = []; rpc.mockClear(); });

describe('RT-6 research host context', () => {
  it('hands over the newest three cards with their confirmation ids, and counts host-qualified benchmarks', async () => {
    rows = [row('a', true, 12000), row('big', false, 300000), row('b', true, 50000), row('a', true, 12000)];
    const research = await researchHostContext(admin, actor, session);
    expect(research).toEqual({ note: RESEARCH_CARDS_NOTE, cards: [
      { kind: 'keywords', cardId: uuid(2), confirmationId: uuid(12), keywords: ['小户型'] },
      { kind: 'candidates', cardId: uuid(3), confirmationId: uuid(13), discoveryId: uuid(99),
        accounts: [{ platform: 'tiktok', account: 'homeideas' }] },
      { kind: 'candidates', cardId: uuid(4), confirmationId: null, discoveryId: null, accounts: [] },
    ], benchmarks: { required: 3, qualified: 2, rows: expect.any(Array) } });
    // Qualified first; numbers are copied from the host table, not computed here.
    expect(research!.benchmarks.rows.map((r: { account: string }) => r.account)).toEqual(['a', 'b', 'a', 'big']);
    expect(rpc).toHaveBeenCalledWith('research_confirmation_read', { a: actor, s: session, p_confirmation: uuid(13) });
    expect(hostTurnContextSchema.parse(withResearchContext(base, research)).research).toEqual(research);
  });

  it('admission adds it only with the switch on (from its one settings read) for a non-opening, non-summary turn', async () => {
    for (const read of [null, settings(), settings(false), Promise.resolve({ ok: false } as const)]) {
      expect(await researchHost(base, admin, actor, session, read)).toBe(base);
    }
    for (const other of [{ ...base, opening: true }, { ...base, stepSummary: { stepId: 'step-2' } } as unknown as HostTurnContext]) {
      expect(await researchHost(other, admin, actor, session, settings(true))).toBe(other);
    }
    // No research read happens on any of these paths.
    expect(rpc).not.toHaveBeenCalled();
    const on = await researchHost(base, admin, actor, session, settings(true));
    expect(on.research?.note).toBe(RESEARCH_CARDS_NOTE);
    expect(rpc).toHaveBeenCalledWith('research_user_cards', { a: actor, s: session });
  });

  it('a read failure leaves it out instead of failing the turn', async () => {
    for (const name of ['research_user_cards', 'research_confirmation_read', 'research_benchmark_rows']) {
      failing = name;
      expect(await researchHostContext(admin, actor, session)).toBeUndefined();
    }
    expect(await researchHost(base, admin, actor, session, settings(true))).toEqual(base);
  });

  it('stays within the host context ceiling: unqualified rows go first, then the oldest cards', async () => {
    rows = [...Array.from({ length: 6 }, (_, i) => row(`q${i}`, true, 20000)), ...Array.from({ length: 6 }, (_, i) => row(`h${i}`, false, 300000))];
    const research = (await researchHostContext(admin, actor, session))!;
    // Pad the checklist until the full research block overflows the ceiling by a few hundred bytes.
    const fields: HostTurnContext['checklist'][number]['fields'] = [];
    const padded: HostTurnContext = { ...base, checklist: [{ id: 's', title: 'pad', fields }] };
    const size = () => Buffer.byteLength(JSON.stringify({ ...padded, research }));
    while (size() <= HOST_TURN_MAX_BYTES + 600) fields.push({ id: `f${fields.length}`, title: 'y'.repeat(100), required: false,
      role: 'user_fact', status: 'missing', protected: true });
    const merged = withResearchContext(padded, research);
    expect(Buffer.byteLength(JSON.stringify(merged))).toBeLessThanOrEqual(HOST_TURN_MAX_BYTES);
    expect(merged.research!.benchmarks.qualified).toBe(6);
    expect(merged.research!.benchmarks.rows.filter((r: { qualified: boolean }) => r.qualified)).toHaveLength(6);
    expect(merged.research!.benchmarks.rows.length).toBeLessThan(12);
    expect(hostTurnContextSchema.safeParse(merged).success).toBe(true);
  });
});

describe('RT-6 tool descriptions name the real host field', () => {
  it('every description that points at host records uses hostTurnContext.research.cards, which the schema has', async () => {
    const { RESEARCH_TOOL_DESCRIPTIONS } = await import('../research/tools/schemas');
    const pointing = Object.values(RESEARCH_TOOL_DESCRIPTIONS).filter(text => text.includes('hostTurnContext'));
    expect(pointing).toHaveLength(3);
    for (const text of pointing) expect(text.match(/hostTurnContext\.[A-Za-z.]+/g)).toEqual(['hostTurnContext.research.cards']);
    expect(Object.keys(hostTurnContextSchema.shape.research.unwrap().shape)).toContain('cards');
  });
});
