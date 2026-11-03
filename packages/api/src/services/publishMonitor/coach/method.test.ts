/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { logger } from '../../../lib/logger';
import { COACH_METHOD_PATH, MAX_COACH_METHOD_BYTES, loadCoachMethod } from './method';

const PACKAGE = JSON.stringify({ skillId: '11111111-1111-4111-8111-111111111111', revisionId: '33333333-3333-4333-8333-333333333333',
  packageHash: 'b'.repeat(64) });
const env = { PUBLISH_MONITOR_HANDBOOK_PACKAGE: PACKAGE };
const b64 = (text: string) => Buffer.from(text).toString('base64');
const admin = (answer: { data: unknown; error: unknown }) => ({ rpc: vi.fn(async () => answer) }) as never;
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
beforeEach(() => warn.mockClear());

it('reads method.md from the pinned package, trimmed', async () => {
  const db = admin({ data: b64('\n  方法正文  \n'), error: null });
  expect(await loadCoachMethod(db, env)).toEqual({ ok: true, text: '方法正文' });
  expect((db as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith('fusion_review_skill_file',
    expect.objectContaining({ p_path: COACH_METHOD_PATH, p_package_hash: 'b'.repeat(64) }));
  expect(warn).not.toHaveBeenCalled();
});
it('no pinned package, an unreadable or empty or oversized file: unavailable with one fixed code, never text', async () => {
  const cases: Array<[Record<string, string | undefined>, { data: unknown; error: unknown }, string]> = [
    [{}, { data: b64('x'), error: null }, 'NOT_CONFIGURED'],
    [{ PUBLISH_MONITOR_HANDBOOK_PACKAGE: '{bad' }, { data: b64('x'), error: null }, 'NOT_CONFIGURED'],
    [env, { data: null, error: { message: 'secret detail' } }, 'READ_FAILED'],
    [env, { data: null, error: null }, 'EMPTY'],
    [env, { data: b64('   \n'), error: null }, 'EMPTY'],
    [env, { data: b64('字'.repeat(MAX_COACH_METHOD_BYTES)), error: null }, 'TOO_LARGE'],
  ];
  for (const [e, answer, reason] of cases) {
    warn.mockClear();
    expect(await loadCoachMethod(admin(answer), e, 'chat')).toEqual({ ok: false, reason });
    expect(warn).toHaveBeenCalledWith('billing', 'coach_method_unavailable', { surface: 'chat', reason });
  }
});
