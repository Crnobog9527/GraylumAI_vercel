/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { generateDataset } from '../../publishMonitor/coach/simulatedDataset';
import { REVIEW_PACK_RESERVE } from '../../publishMonitor/coach/stats';
import { packRowsFor } from '../../publishMonitor/coach/testRows';
import { OWN_POSTS_RESERVE, postResultBytes } from '../agent/workspacePosts';
import { NO_ACCESS, workspaceTurnReader, type PostsAccess } from './workspace';

// Dated today: the reader builds the pack at the current time, so the simulated data must be current to be full size.
const data = generateDataset({ asOf: new Date().toISOString().slice(0, 10) });
const brand = '00000000-0000-4000-8000-0000000000b1';
const rows = JSON.parse(JSON.stringify(packRowsFor(data, data.accounts.find(a => a.key === 'A')!)));
const coach = (windowDays: number): PostsAccess => ({ windowDays, benchmarks: false, review: false, coach: true });
function reader(posts: PostsAccess | null, answer: unknown = { kind: 'coach_rows', businessId: brand, rows }) {
  const rpc = vi.fn(async (name: string) => ({ error: null, data: name === 'coach_pack_turn_read' ? answer : { kind: 'workspace_index', entries: [] } }));
  return { rpc, read: workspaceTurnReader({ rpc } as never, 'actor', 'session', { ...NO_ACCESS, posts }) };
}
const parsed = async (text: Promise<{ text: string }>) => JSON.parse((await text).text);

describe('a review asked for in chat (PUBLISH-MONITOR block E)', () => {
  it('lists the review entry only while the coach switch is on', async () => {
    const ids = async (posts: PostsAccess | null) => (await parsed(reader(posts).read(''))).entries.map((e: { id: string }) => e.id);
    expect(await ids(coach(30))).toContain('coach_review');
    expect(await ids({ ...coach(30), coach: false })).not.toContain('coach_review');
    expect(await ids(null)).not.toContain('coach_review');
  });

  it('allowed: a member reads the code-built chat pack of their brand by the owner key, through the read client', async () => {
    const { rpc, read } = reader(coach(30));
    const result = await parsed(read('coach_review'));
    expect(rpc).toHaveBeenCalledWith('coach_pack_turn_read', { p_actor_id: 'actor', p_session_id: 'session', p_business_id: null });
    expect(result).toMatchObject({ kind: 'coach_review', status: 'available', review: { kind: 'review_pack', cadence: 'chat', business_id: brand } });
    // Chat never proposes a pillar mix or a strategy change (those are the monthly and quarterly reviews').
    expect(result.review.limits.experiment_kinds).not.toContain('pillar_mix');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(REVIEW_PACK_RESERVE + 200);
  });

  it('several brands are listed with ids the model can read back; a named brand is passed through', async () => {
    const other = '00000000-0000-4000-8000-0000000000b2';
    const listed = reader(coach(90), { kind: 'coach_brands', brands: [{ id: brand, name: 'A' }, { id: other, name: null }] });
    expect(await parsed(listed.read('coach_review'))).toEqual({ kind: 'coach_brands',
      brands: [{ id: `coach_review:${brand}`, name: 'A' }, { id: `coach_review:${other}`, name: null }] });
    const named = reader(coach(90));
    await named.read(`coach_review:${other}`);
    expect(named.rpc).toHaveBeenCalledWith('coach_pack_turn_read', { p_actor_id: 'actor', p_session_id: 'session', p_business_id: other });
  });

  it('refused: a free member reads the members-only note and nothing from the database; switch off or a bad id reads nothing', async () => {
    const free = reader(coach(0));
    expect(await parsed(free.read('coach_review'))).toMatchObject({ kind: 'coach_review', status: 'no_entitlement' });
    const off = reader({ ...coach(90), coach: false });
    expect(await parsed(off.read('coach_review'))).toEqual({ kind: 'unavailable' });
    const bad = reader(coach(90));
    expect(await parsed(bad.read('coach_review:not-a-uuid'))).toEqual({ kind: 'unavailable' });
    for (const r of [free, off, bad]) expect(r.rpc).not.toHaveBeenCalled();
  });

  it('refused: another owner\'s brand comes back unavailable, and the review shares the two post reads of an answer', async () => {
    expect(await parsed(reader(coach(90), { kind: 'unavailable', reason: 'brand_not_found' }).read(`coach_review:${brand}`)))
      .toEqual({ kind: 'unavailable', reason: 'brand_not_found' });
    const { rpc, read } = reader(coach(90), { kind: 'coach_review', status: 'no_brand' });
    await read('coach_review'); await read('coach_review');
    expect(await parsed(read('coach_review'))).toMatchObject({ kind: 'unavailable', reason: 'read_limit' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('two reads never pass the room kept before turn_open: a second pack that does not fit is a short note', async () => {
    const { read } = reader(coach(90));
    const first = await read('coach_review'), second = await read('coach_review');
    expect(JSON.parse(first.text)).toMatchObject({ status: 'available' });
    expect(JSON.parse(second.text)).toMatchObject({ kind: 'unavailable', reason: 'read_room' });
    expect(postResultBytes(JSON.parse(first.text)) + postResultBytes(JSON.parse(second.text))).toBeLessThanOrEqual(OWN_POSTS_RESERVE);
  });

  it('no brand with a connected account: a note, never an empty pack', async () => {
    expect(await parsed(reader(coach(30), { kind: 'coach_review', status: 'no_brand' }).read('coach_review')))
      .toMatchObject({ kind: 'coach_review', status: 'no_brand' });
  });
});

describe('the handbooks of the access reach the chat pack', () => {
  it('a member whose access holds the handbooks gets the reference lines; without them the pack has an empty list', async () => {
    const platform = (rows.facts[0] as { platform: string }).platform;
    const handbook = { platform, version: 't', calibration: 'owner_confirmed', labels: {},
      funnel: [{ layer: 'hook', name: '开头', keys: ['bounce_2s'], basics: true, pass: { bounce_2s: { max: 0.4 } } }] };
    const withBooks = await parsed(reader({ ...coach(30), handbooks: new Map([[platform, handbook as never]]) }).read('coach_review'));
    expect(withBooks.review.reference_lines).toMatchObject([{ platform, calibration: 'owner_confirmed', funnel: [{ layer: 'hook', pass: { bounce_2s: { max: 0.4 } } }] }]);
    expect((await parsed(reader(coach(30)).read('coach_review'))).review.reference_lines).toEqual([]);
  });
});
