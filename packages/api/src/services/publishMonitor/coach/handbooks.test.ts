/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../lib/logger';
import { HANDBOOK_PACKAGE_ENV, loadCoachHandbooks, loadHandbooks, packageReader, parseHandbook, readHandbookPackage } from './handbooks';
import { handbookSchema, type Handbook } from './funnel';
import { buildPack } from './pack';
import { packRowsSchema } from './rows';
import { generateDataset } from './simulatedDataset';
import { packRowsFor, simId } from './testRows';

const AS_OF = '2026-10-27';
const NOW = Date.parse(AS_OF + 'T00:00:00Z');
const PACKAGE = { moduleId: 'm1', skillId: 'coach', revisionId: 'r1', packageHash: 'a'.repeat(64) };
const ENV = { [HANDBOOK_PACKAGE_ENV]: JSON.stringify(PACKAGE) };
const ACTOR = '22222222-2222-4222-8222-222222222222';

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
/** A database whose read_skill_package serves `files` (path -> text); a path that is not there answers null. */
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
    const files = { 'handbook/douyin.json': JSON.stringify(handbookOf('douyin')), 'handbook/tiktok.json': '{"platform":"tiktok"}' };
    const map = await loadHandbooks(async path => files[path as keyof typeof files] ?? null);
    expect([...map.keys()]).toEqual(['douyin']);
    expect(warn).toHaveBeenCalledWith('billing', 'coach_handbook_invalid', { platform: 'tiktok' });
    const failing = await loadHandbooks(async path => { if (path.includes('douyin')) throw new Error('COACH_HANDBOOK_READ_FAILED'); return null; });
    expect(failing.size).toBe(0);
  });

  it('reads handbook/<platform>.json of the pinned package for the actor, through read_skill_package', async () => {
    const d = database({ 'handbook/douyin.json': JSON.stringify(handbookOf('douyin')), 'handbook/tiktok.json': JSON.stringify(handbookOf('tiktok', 'draft')) });
    const map = await loadHandbooks(packageReader(d.db, ACTOR, PACKAGE));
    expect([...map.keys()].sort()).toEqual(['douyin', 'tiktok']);
    expect(map.get('tiktok')?.calibration).toBe('draft');
    expect(d.rpc).toHaveBeenCalledWith('read_skill_package', expect.objectContaining({ p_actor_id: ACTOR, p_module_id: 'm1', p_skill_id: 'coach',
      p_revision_id: 'r1', p_package_hash: PACKAGE.packageHash, p_path: 'handbook/douyin.json' }));
  });

  it('an error from the package read is a thrown read failure, not an empty handbook', async () => {
    const d = database({ 'handbook/douyin.json': new Error('boom') });
    await expect(packageReader(d.db, ACTOR, PACKAGE)('handbook/douyin.json')).rejects.toThrow('COACH_HANDBOOK_READ_FAILED');
  });
});

describe('the handbooks of this deployment', () => {
  it('without a pinned package nothing is read and the Map is empty', async () => {
    const d = database({});
    expect((await loadCoachHandbooks(d.db, ACTOR, {})).size).toBe(0);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it('an unreadable package is an empty Map: the review still runs, on the user\'s own data', async () => {
    const d = database({ 'handbook/douyin.json': new Error('down'), 'handbook/tiktok.json': new Error('down') });
    expect((await loadCoachHandbooks(d.db, ACTOR, { [HANDBOOK_PACKAGE_ENV]: JSON.stringify({ ...PACKAGE, revisionId: 'r-down' }) })).size).toBe(0);
  });

  it('reads the package on every review, so a revoked handbook is never served from memory', async () => {
    const files = { 'handbook/douyin.json': JSON.stringify(handbookOf('douyin')), 'handbook/tiktok.json': JSON.stringify(handbookOf('tiktok')) };
    const d = database(files);
    await loadCoachHandbooks(d.db, ACTOR, ENV);
    await loadCoachHandbooks(d.db, ACTOR, ENV);
    expect(d.rpc).toHaveBeenCalledTimes(4);
  });
});

describe('the pack built with loaded handbooks (simulated account A)', () => {
  const data = generateDataset({ asOf: AS_OF });
  const rows = packRowsSchema.parse(packRowsFor(data, data.accounts.find(a => a.key === 'A')!));
  const diagnostics = (rates: Record<string, number>) => rows.diagnostics.slice(0, 3).map(d => ({ ...d, platform: 'douyin', rates, reviewRunId: null, capturedOn: AS_OF }));
  const pack = (handbooks: Map<string, Handbook>, rates: Record<string, number>) => JSON.parse(JSON.stringify(
    buildPack({ rows: { ...rows, diagnostics: diagnostics(rates) }, cadence: 'weekly', businessId: simId('A'), now: NOW, handbooks })));
  const loaded = async () => loadHandbooks(packageReader(database({ 'handbook/douyin.json': JSON.stringify(handbookOf('douyin')) }).db, ACTOR, PACKAGE));
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
