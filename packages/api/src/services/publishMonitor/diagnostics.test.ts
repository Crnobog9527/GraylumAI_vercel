/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RATE_KEYS } from './coach/funnel';
import { deleteDiagnostic, DiagnosticError, diagnosticInput, listCandidates, saveDiagnostic } from './diagnostics';

const actor = '00000000-0000-4000-8000-0000000f0001', post = '00000000-0000-4000-8000-0000000f0002';
const db = (data: unknown, error: unknown = null) => { const rpc = vi.fn(async () => ({ data, error })); return { rpc, db: { rpc } as never }; };

describe('single-post diagnosis entry', () => {
  it('sends confirmed fractions, trimmed opening lines and the lengths to the save function', async () => {
    const d = db({ id: post, capturedOn: '2026-11-03' });
    expect(await saveDiagnostic(d.db, actor, { postId: post, rates: { bounce_2s: 0.42, avg_watch_seconds: 7.5 }, openingText: '  第一句\n第二句  ',
      videoSeconds: 30, dropSecond: 4 })).toEqual({ id: post, capturedOn: '2026-11-03' });
    expect(d.rpc).toHaveBeenCalledWith('publish_monitor_diagnostic_save', { a: actor, p_post: post, p_rates: { bounce_2s: 0.42, avg_watch_seconds: 7.5 },
      p_opening: '第一句\n第二句', p_video: 30, p_drop: 4, p_captured: null });
  });

  it('refuses what is not a normalized rate: unknown keys, fractions above 1, negative numbers, empty, a drop after the end', async () => {
    const bad = (extra: object) => ({ postId: post, rates: { bounce_2s: 0.4 }, ...extra });
    const cases: unknown[] = [bad({ rates: {} }), bad({ rates: { made_up: 0.4 } }), bad({ rates: { bounce_2s: 1.2 } }), bad({ rates: { bounce_2s: -0.1 } }),
      bad({ rates: { bounce_2s: Number.NaN } }), bad({ rates: { avg_watch_seconds: 90_000 } }), bad({ videoSeconds: 10, dropSecond: 11 }),
      bad({ videoSeconds: 0 }), bad({ capturedOn: '3 Nov' }), { postId: 'x', rates: { bounce_2s: 0.4 } }, { ...bad({}), extra: 1 }];
    for (const input of cases) {
      const d = db({});
      await expect(saveDiagnostic(d.db, actor, input as never)).rejects.toMatchObject({ code: 'PUBLISH_MONITOR_IMPORT_INVALID' });
      expect(d.rpc).not.toHaveBeenCalled();
    }
    // Seconds may exceed 1 only for the one key that is a count of seconds.
    expect(diagnosticInput.safeParse({ postId: post, rates: { avg_watch_seconds: 12 } }).success).toBe(true);
  });

  it('maps the database\'s refusals: a post that is not the user\'s own, invalid input, anything else', async () => {
    const codeOf = async (message: string) => saveDiagnostic(db(null, { message }).db, actor, { postId: post, rates: { like_rate: 0.1 } })
      .catch((error: DiagnosticError) => error.code);
    expect(await codeOf('PUBLISH_MONITOR_POST_NOT_FOUND')).toBe('PUBLISH_MONITOR_POST_NOT_FOUND');
    expect(await codeOf('PUBLISH_MONITOR_INPUT_INVALID')).toBe('PUBLISH_MONITOR_IMPORT_INVALID');
    expect(await codeOf('boom')).toBe('PUBLISH_MONITOR_UNAVAILABLE');
    await expect(saveDiagnostic(db({ unexpected: true }).db, actor, { postId: post, rates: { like_rate: 0.1 } })).rejects.toMatchObject({ code: 'PUBLISH_MONITOR_UNAVAILABLE' });
  });

  it('lists candidates and deletes by id through the database functions, validating what comes back', async () => {
    const row = { postId: post, platform: 'douyin', title: '标题', postedAt: '2026-11-01T00:00:00Z', businessId: actor, businessName: '品牌', diagnosedOn: null };
    const d = db([row]);
    expect(await listCandidates(d.db, actor)).toEqual([row]);
    expect(d.rpc).toHaveBeenCalledWith('publish_monitor_diagnostic_candidates', { a: actor });
    await expect(listCandidates(db([{ nope: 1 }]).db, actor)).rejects.toMatchObject({ code: 'PUBLISH_MONITOR_UNAVAILABLE' });
    expect(await deleteDiagnostic(db(true).db, actor, { id: post })).toBe(true);
    await expect(deleteDiagnostic(db(true).db, actor, { id: 'x' })).rejects.toMatchObject({ code: 'PUBLISH_MONITOR_IMPORT_INVALID' });
  });

  it('the database function accepts exactly the rate keys the code knows (the two lists cannot drift)', () => {
    const sql = readFileSync(new URL('../../../../db/migrations/0498_publish_monitor_diagnostic_entry.sql', import.meta.url), 'utf8');
    const listed = /keys text\[\]:=ARRAY\[([^\]]+)\]/.exec(sql)![1]!.match(/'[a-z0-9_]+'/g)!.map(key => key.slice(1, -1));
    expect([...listed].sort()).toEqual([...RATE_KEYS].sort());
  });
});
