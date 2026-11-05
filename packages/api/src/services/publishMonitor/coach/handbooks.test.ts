/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../lib/logger';
import { clearChatHandbookCache, HANDBOOK_PACKAGE_ENV, loadChatHandbooks, loadCoachHandbooks, loadHandbooks, packageReader, parseHandbook, readHandbookPackage } from './handbooks';
import { handbookSchema, type Handbook } from './funnel';
import { buildPack } from './pack';
import { packRowsSchema } from './rows';
import { generateDataset } from './simulatedDataset';
import { packRowsFor, simId } from './testRows';

const AS_OF = '2026-10-27';
const NOW = Date.parse(AS_OF + 'T00:00:00Z');
const PACKAGE = { skillId: '11111111-1111-4111-8111-111111111111', revisionId: '33333333-3333-4333-8333-333333333333', packageHash: 'a'.repeat(64) };
const ENV = { [HANDBOOK_PACKAGE_ENV]: JSON.stringify(PACKAGE) };

/** Placeholder numbers for tests only; the real handbooks live in the private Skill package. */
const handbookOf = (platform: string, calibration: 'owner_confirmed' | 'draft' = 'owner_confirmed'): Handbook => handbookSchema.parse({
  platform, version: 'test', calibration, labels: { '5秒完播率': 'retain_5s' },
  funnel: [
    { layer: 'hook', name: '前 2–3 秒停留', keys: ['bounce_2s', 'retain_3s'], basics: true, pass: { bounce_2s: { max: 0.5 }, retain_3s: { min: 0.45 } } },
    { layer: 'retain5', name: '5 秒留存', keys: ['retain_5s'], basics: true, pass: { retain_5s: { min: 0.3 } } },
    { layer: 'engage', name: '互动', keys: ['like_rate'], basics: false, pass: { like_rate: { min: 0.04 } } },
  ],
});
const base64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64');
/** A database whose fusion_review_skill_file serves `files` (path -> text); a path that is not there answers null. */
function database(files: Record<string, string | Error>) {
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const file = files[String(args.p_path)];
    if (file instanceof Error) return { data: null, error: { message: file.message } };
    return { data: file === undefined ? null : base64(file), error: null };
  });
  return { rpc, db: { rpc } as never };
}
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
beforeEach(() => { warn.mockClear(); });

describe('reading the pinned package setting', () => {
  it('no setting, a malformed one or a bad hash is no package (logged, never thrown)', () => {
    expect(readHandbookPackage({})).toBeNull();
    expect(readHandbookPackage({ [HANDBOOK_PACKAGE_ENV]: 'not json' })).toBeNull();
    expect(readHandbookPackage({ [HANDBOOK_PACKAGE_ENV]: JSON.stringify({ ...PACKAGE, packageHash: 'abc' }) })).toBeNull();
    expect(readHandbookPackage({ [HANDBOOK_PACKAGE_ENV]: JSON.stringify({ ...PACKAGE, extra: 1 }) })).toBeNull();
    expect(readHandbookPackage(ENV)).toEqual(PACKAGE);
  });
});

describe('one handbook file', () => {
  it('is accepted only when it is JSON, passes the handbook schema and names the platform it was read for', () => {
    const text = JSON.stringify(handbookOf('douyin'));
    expect(parseHandbook(text, 'douyin')?.platform).toBe('douyin');
    expect(parseHandbook(text, 'tiktok')).toBeNull();
    expect(parseHandbook('{', 'douyin')).toBeNull();
    expect(parseHandbook(JSON.stringify({ ...handbookOf('douyin'), funnel: [] }), 'douyin')).toBeNull();
    expect(parseHandbook(JSON.stringify({ ...handbookOf('douyin'), calibration: 'courseware' }), 'douyin')).toBeNull();
  });
});

describe('loading the handbooks of a package', () => {
  it('keeps the readable valid ones and leaves out a missing, failing or invalid one', async () => {
    const files = { 'handbook/douyin.yaml': JSON.stringify(handbookOf('douyin')), 'handbook/tiktok.yaml': '{"platform":"tiktok"}' };
    const map = await loadHandbooks(async path => files[path as keyof typeof files] ?? null);
    expect([...map.keys()]).toEqual(['douyin']);
    expect(warn).toHaveBeenCalledWith('billing', 'coach_handbook_invalid', { platform: 'tiktok' });
    const failing = await loadHandbooks(async path => { if (path.includes('douyin')) throw new Error('COACH_HANDBOOK_READ_FAILED'); return null; });
    expect(failing.size).toBe(0);
  });

  it('reads handbook/<platform>.yaml of the pinned package through fusion_review_skill_file', async () => {
    const d = database({ 'handbook/douyin.yaml': JSON.stringify(handbookOf('douyin')), 'handbook/tiktok.yaml': JSON.stringify(handbookOf('tiktok', 'draft')) });
    const map = await loadHandbooks(packageReader(d.db, PACKAGE));
    expect([...map.keys()].sort()).toEqual(['douyin', 'tiktok']);
    expect(map.get('tiktok')?.calibration).toBe('draft');
    expect(d.rpc).toHaveBeenCalledWith('fusion_review_skill_file', expect.objectContaining({ p_skill_id: PACKAGE.skillId,
      p_revision_id: PACKAGE.revisionId, p_package_hash: PACKAGE.packageHash, p_path: 'handbook/douyin.yaml' }));
  });

  it('an error from the package read is a thrown read failure, not an empty handbook', async () => {
    const d = database({ 'handbook/douyin.yaml': new Error('boom') });
    await expect(packageReader(d.db, PACKAGE)('handbook/douyin.yaml')).rejects.toThrow('COACH_HANDBOOK_READ_FAILED');
  });
});

describe('the handbooks of this deployment', () => {
  it('without a pinned package nothing is read and the Map is empty', async () => {
    const d = database({});
    expect((await loadCoachHandbooks(d.db, {})).size).toBe(0);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it('an unreadable package is an empty Map: the review still runs, on the user\'s own data', async () => {
    const d = database({ 'handbook/douyin.yaml': new Error('down'), 'handbook/tiktok.yaml': new Error('down') });
    expect((await loadCoachHandbooks(d.db, { [HANDBOOK_PACKAGE_ENV]: JSON.stringify(PACKAGE) })).size).toBe(0);
  });

  it('reads the package on every review, so a revoked handbook is never served from memory', async () => {
    const files = { 'handbook/douyin.yaml': JSON.stringify(handbookOf('douyin')), 'handbook/tiktok.yaml': JSON.stringify(handbookOf('tiktok')) };
    const d = database(files);
    await loadCoachHandbooks(d.db, ENV);
    await loadCoachHandbooks(d.db, ENV);
    expect(d.rpc).toHaveBeenCalledTimes(4);
  });
});

describe('the pack built with loaded handbooks (simulated account A)', () => {
  const data = generateDataset({ asOf: AS_OF });
  const rows = packRowsSchema.parse(packRowsFor(data, data.accounts.find(a => a.key === 'A')!));
  const diagnostics = (rates: Record<string, number>) => rows.diagnostics.slice(0, 3).map(d => ({ ...d, platform: 'douyin', rates, reviewRunId: null, capturedOn: AS_OF }));
  const pack = (handbooks: Map<string, Handbook>, rates: Record<string, number>) => JSON.parse(JSON.stringify(
    buildPack({ rows: { ...rows, diagnostics: diagnostics(rates) }, cadence: 'weekly', businessId: simId('A'), now: NOW, handbooks })));
  const loaded = async () => loadHandbooks(packageReader(database({ 'handbook/douyin.yaml': JSON.stringify(handbookOf('douyin')) }).db, PACKAGE));
  const GOOD = { bounce_2s: 0.3, retain_3s: 0.6, retain_5s: 0.5, like_rate: 0.06 };
  const BAD = { bounce_2s: 0.95, retain_3s: 0.1, retain_5s: 0.05 };

  it('with a handbook the basics are judged by its lines: all passing keeps the full review', async () => {
    const p = pack(await loaded(), GOOD);
    expect(p.mode).toBe('full');
    expect(p.diagnostics).toMatchObject({ requested: true, basics_pass: true });
  });

  it('with a handbook and failing basics the review covers only the basics', async () => {
    const p = pack(await loaded(), BAD);
    expect(p.mode).toBe('basics_only');
    expect(p.diagnostics.basics_pass).toBe(false);
    expect(p.diagnostics.posts[0].stuck_layer).toBe('hook');
  });

  it('without a handbook the same failing numbers are not judged: the full review, basics_pass unknown', () => {
    const p = pack(new Map(), BAD);
    expect(p.mode).toBe('full');
    expect(p.diagnostics.basics_pass).toBeNull();
    expect(p.diagnostics.posts.every((x: { stuck_layer: unknown }) => x.stuck_layer === null)).toBe(true);
  });

  it('a draft handbook never says fails: it only compares with the user\'s own posts', async () => {
    const draft = new Map([['douyin', handbookOf('douyin', 'draft')]]);
    const p = pack(draft, BAD);
    expect(p.mode).toBe('full');
    expect(p.diagnostics.basics_pass).toBeNull();
  });
});

describe('handbooks and reference lines for a chat review', () => {
  const files = () => ({ 'handbook/douyin.yaml': JSON.stringify(handbookOf('douyin')), 'handbook/tiktok.yaml': JSON.stringify(handbookOf('tiktok')) });
  beforeEach(() => clearChatHandbookCache());

  it('a chat pack lists the own posts a screenshot can be matched to even when the basics fail and only three posts are diagnosed (D-6/D-8, 2026-11-05)', () => {
    const data = generateDataset({ asOf: AS_OF });
    const rows = packRowsSchema.parse(packRowsFor(data, data.accounts.find(a => a.key === 'A')!));
    const failing = rows.diagnostics.slice(0, 3).map(d => ({ ...d, platform: 'douyin', rates: { retain_5s: 0.05 }, reviewRunId: null, capturedOn: AS_OF }));
    const handbooks = new Map([['douyin', handbookOf('douyin')]]);
    const pack = JSON.parse(JSON.stringify(buildPack({ rows: { ...rows, diagnostics: failing }, cadence: 'chat', businessId: simId('A'), now: NOW, handbooks })));
    expect(pack.mode).toBe('basics_only');
    const diagnosed = new Set(pack.diagnostics.posts.map((p: { post_id: string }) => p.post_id));
    const listed = pack.posts_index as Array<{ post_id: string; title: string | null }>;
    // A recent post that has no diagnosis is in the list, with its title, so it can be matched.
    const undiagnosed = rows.recent.find(p => !diagnosed.has(p.postId))!;
    expect(listed.find(p => p.post_id === undiagnosed.postId)?.title).toBe(undiagnosed.title);
    expect(listed.length).toBeLessThanOrEqual(30);
    expect(JSON.stringify(pack).length).toBeLessThan(16_000);
    // The scheduled review's pack is unchanged: no list.
    const weekly = JSON.parse(JSON.stringify(buildPack({ rows: { ...rows, diagnostics: failing }, cadence: 'weekly', businessId: simId('A'), now: NOW, handbooks })));
    expect(weekly.posts_index).toBeUndefined();
  });

  it('a chat turn reads the package once per ten minutes, and a failed or empty read is tried again at once', async () => {
    const d = database(files());
    const t0 = 1_000_000;
    expect((await loadChatHandbooks(d.db, ENV, t0)).size).toBe(2);
    expect((await loadChatHandbooks(d.db, ENV, t0 + 9 * 60_000)).size).toBe(2);
    expect(d.rpc).toHaveBeenCalledTimes(2);
    await loadChatHandbooks(d.db, ENV, t0 + 11 * 60_000);
    expect(d.rpc).toHaveBeenCalledTimes(4);
    clearChatHandbookCache();
    const down = database({ 'handbook/douyin.yaml': new Error('down'), 'handbook/tiktok.yaml': new Error('down') });
    expect((await loadChatHandbooks(down.db, ENV, t0)).size).toBe(0);
    await loadChatHandbooks(down.db, ENV, t0 + 1000);
    expect(down.rpc).toHaveBeenCalledTimes(2);
    await loadChatHandbooks(down.db, ENV, t0 + 61_000);
    expect(down.rpc).toHaveBeenCalledTimes(4);
    expect((await loadChatHandbooks(down.db, {}, t0)).size).toBe(0);
  });

  it('turns that start together share one read, and a hung read does not hold a turn back', async () => {
    const d = database(files());
    const [a, b] = await Promise.all([loadChatHandbooks(d.db, ENV, 5), loadChatHandbooks(d.db, ENV, 5)]);
    expect([a.size, b.size]).toEqual([2, 2]);
    expect(d.rpc).toHaveBeenCalledTimes(2);
    clearChatHandbookCache();
    vi.useFakeTimers();
    try {
      const rpc = vi.fn(() => new Promise(() => {})), hung = { rpc } as never;
      const pending = loadChatHandbooks(hung, ENV, 5);
      await vi.advanceTimersByTimeAsync(2_100);
      expect((await pending).size).toBe(0);
      // The next turn inside the minute does not wait or start another read; after it, a new read starts and sees the recovered service.
      expect((await loadChatHandbooks(hung, ENV, 6)).size).toBe(0);
      expect(rpc).toHaveBeenCalledTimes(2);
      const healthy = database(files());
      expect((await loadChatHandbooks(healthy.db, ENV, 70_000)).size).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  const data = generateDataset({ asOf: AS_OF });
  const rows = packRowsSchema.parse(packRowsFor(data, data.accounts.find(a => a.key === 'A')!));
  const books = new Map([['douyin', parseHandbook(JSON.stringify(handbookOf('douyin')), 'douyin')!],
    ['tiktok', parseHandbook(JSON.stringify(handbookOf('tiktok')), 'tiktok')!]]);
  const chat = (cadence: 'chat' | 'weekly', handbooks = books) =>
    JSON.parse(JSON.stringify(buildPack({ rows, cadence, businessId: simId('A'), now: NOW, handbooks })));

  it('the chat pack carries the lines of the platforms the brand posts on, so a screenshot\'s rates have something to be compared with', () => {
    const platforms = new Set([...rows.facts, ...rows.recent, ...rows.accounts].map(x => x.platform));
    const lines = chat('chat').reference_lines as Array<{ platform: string; calibration: string; funnel: unknown[] }>;
    expect(lines.map(l => l.platform)).toEqual([...platforms].filter(p => books.has(p)).sort());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatchObject({ calibration: 'owner_confirmed' });
    expect(JSON.stringify(lines)).not.toContain('"labels"');
  });

  it('no handbook, no lines; and a weekly pack never carries them (its diagnoses hold the lines)', () => {
    expect(chat('chat', new Map()).reference_lines).toEqual([]);
    expect(chat('weekly').reference_lines).toBeUndefined();
  });
});
