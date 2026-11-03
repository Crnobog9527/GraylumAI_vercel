/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { saveCoachLedger } from './persist';
import { packRowsSchema } from './rows';
import { generateDataset } from './simulatedDataset';
import { packRowsFor, simId } from './testRows';
import type { CheckedOutput } from './output';

const AS_OF = '2026-10-27';
const data = generateDataset({ asOf: AS_OF });
const account = data.accounts.find(a => a.key === 'A')!;
const rows = packRowsSchema.parse(packRowsFor(data, account));
const claim = { id: simId('R'), token: simId('T'), actorId: simId('U') };
const pack = { review: { as_of: AS_OF, cadence: 'weekly', period: { start: '2026-10-20', end: '2026-10-26' } } };
const platform = rows.facts[0]!.platform, pillar = rows.facts.find(f => f.pillarKey)!.pillarKey!;
const checked = (over: Partial<CheckedOutput> = {}): CheckedOutput => ({ body: '', parsed: true, mode_mismatch: false, rejected: [],
  diagnoses: [], verdict_notes: [{ experiment_id: simId('E'), note: '有效' }], tags: [{ post_id: simId('P'), pillar_key: 'p1' }],
  experiments: [{ kind: 'tactic', layer: null, hypothesis: 'h', action: 'a', metric: 'views', target: { mult: 1.5 },
    match: { pillar_key: pillar, platform }, evidence: { post_ids: [], metrics: [] } }],
  pillar_mix_proposal: null, strategy_proposal: null, stage_suggestion: null, ...over });
const database = (saved: unknown = { saved: true }, error: unknown = null) => {
  const rpc = vi.fn(async (name: string) => (name === 'publish_monitor_review_pack_rows' ? { data: rows, error: null } : { data: saved, error }));
  return { rpc, db: { rpc } as never };
};
type Sent = { p_id: string; p_token: string; p_payload: { experiments: Array<Record<string, unknown>>; verdict_notes: unknown[]; tags: unknown[] } };
const payloadOf = (rpc: ReturnType<typeof database>['rpc']) => (rpc.mock.calls as unknown as Array<[string, Sent]>)
  .find(c => c[0] === 'publish_monitor_review_save_coach')![1];

it('sends the notes, tags and new experiments with a code-frozen baseline and the period after the review\'s', async () => {
  const d = database();
  expect(await saveCoachLedger(d.db, claim, simId('B'), pack, checked())).toBe(true);
  const sent = payloadOf(d.rpc);
  expect(sent).toMatchObject({ p_id: claim.id, p_token: claim.token });
  expect(sent.p_payload.verdict_notes).toHaveLength(1); expect(sent.p_payload.tags).toHaveLength(1);
  expect(sent.p_payload.experiments[0]).toMatchObject({ kind: 'tactic', target_mult: 1.5, target_line: null,
    period_start: '2026-10-27', period_end: '2026-11-02', match: { pillar_key: pillar, platform } });
  expect((sent.p_payload.experiments[0]!.baseline as { basis: string } | null)?.basis ?? 'day7').toBe('day7');
  expect(d.rpc).toHaveBeenCalledWith('publish_monitor_review_pack_rows', expect.objectContaining({ p_business_id: simId('B') }));
});

it('a monthly review proposes for the next 28 days; a rate experiment keeps its line; no facts are read without experiments', async () => {
  const d = database();
  await saveCoachLedger(d.db, claim, simId('B'), { review: { ...pack.review, cadence: 'monthly' } }, checked({ experiments: [{ kind: 'basics',
    layer: 'hook', hypothesis: 'h', action: 'a', metric: 'bounce_2s', target: { max: 0.5 }, match: { pillar_key: pillar, platform },
    evidence: { post_ids: [], metrics: [] } }] }));
  expect(payloadOf(d.rpc).p_payload.experiments[0]).toMatchObject({ target_mult: null, target_line: { max: 0.5 }, period_end: '2026-11-23' });
  const none = database();
  await saveCoachLedger(none.db, claim, simId('B'), pack, checked({ experiments: [] }));
  expect(none.rpc.mock.calls.map(c => c[0])).toEqual(['publish_monitor_review_save_coach']);
});

it('stores only the target that fits the kind, whatever else the experiment carried', async () => {
  const d = database();
  const base = { layer: null, hypothesis: 'h', action: 'a', metric: 'views', match: { pillar_key: pillar, platform }, evidence: { post_ids: [], metrics: [] } };
  await saveCoachLedger(d.db, claim, simId('B'), pack, checked({ experiments: [{ ...base, kind: 'tactic', target: { mult: 1.5, min: 1000 } },
    { ...base, kind: 'basics', layer: 'hook', metric: 'bounce_2s', target: { mult: 2, max: 0.5 } }] }));
  expect(payloadOf(d.rpc).p_payload.experiments.map(e => [e.target_mult, e.target_line])).toEqual([[1.5, null], [null, { max: 0.5 }]]);
});

it('saves nothing for an unparsed block, reports a refused lease, and fails loudly on a database error', async () => {
  const d = database();
  expect(await saveCoachLedger(d.db, claim, simId('B'), pack, checked({ parsed: false }))).toBe(false);
  expect(d.rpc).not.toHaveBeenCalled();
  expect(await saveCoachLedger(database({ saved: false }).db, claim, simId('B'), pack, checked())).toBe(false);
  await expect(saveCoachLedger(database(null, { code: 'XX000' }).db, claim, simId('B'), pack, checked()))
    .rejects.toThrow('PUBLISH_MONITOR_COACH_LEDGER_SAVE_FAILED');
});
