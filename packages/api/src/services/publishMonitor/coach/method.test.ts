/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { logger } from '../../../lib/logger';
import { COACH_METHOD_PATH, MAX_COACH_METHOD_BYTES, MIN_COACH_METHOD_BYTES, loadCoachMethod, skillBody } from './method';

const PACKAGE = JSON.stringify({ skillId: '11111111-1111-4111-8111-111111111111', revisionId: '33333333-3333-4333-8333-333333333333',
  packageHash: 'b'.repeat(64) });
const env = { PUBLISH_MONITOR_HANDBOOK_PACKAGE: PACKAGE };
const b64 = (text: string) => Buffer.from(text).toString('base64');
const admin = (answer: { data: unknown; error: unknown }) => ({ rpc: vi.fn(async () => answer) }) as never;
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
beforeEach(() => warn.mockClear());

const BODY = '方法正文。'.repeat(MIN_COACH_METHOD_BYTES / 6);
it('reads SKILL.md from the pinned package: the front matter is dropped, the body is the method, trimmed', async () => {
  const db = admin({ data: b64(`---\nname: review-coach\ndescription: 说明\n---\n\n  ${BODY}  \n`), error: null });
  expect(await loadCoachMethod(db, env)).toEqual({ ok: true, text: BODY });
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
    [env, { data: b64('---\nname: x\n---\n'), error: null }, 'EMPTY'],
    [env, { data: b64('---\nname: x\ndescription: 只有说明，还没有方法正文\n---\n简短说明。'), error: null }, 'TOO_SHORT'],
    [env, { data: b64('字'.repeat(MAX_COACH_METHOD_BYTES)), error: null }, 'TOO_LARGE'],
  ];
  for (const [e, answer, reason] of cases) {
    warn.mockClear();
    expect(await loadCoachMethod(admin(answer), e, 'chat')).toEqual({ ok: false, reason });
    expect(warn).toHaveBeenCalledWith('billing', 'coach_method_unavailable', { surface: 'chat', reason });
  }
});
it('the size limits are on the trimmed body: exactly the limit is accepted, one byte more is not', async () => {
  const ok = await loadCoachMethod(admin({ data: b64('a'.repeat(MAX_COACH_METHOD_BYTES)), error: null }), env);
  expect(ok).toMatchObject({ ok: true });
  expect(await loadCoachMethod(admin({ data: b64('a'.repeat(MAX_COACH_METHOD_BYTES + 1)), error: null }), env))
    .toEqual({ ok: false, reason: 'TOO_LARGE' });
});
it('skillBody drops only a leading front matter block', () => {
  expect(skillBody('---\r\na: 1\r\n---\r\n正文')).toBe('正文');
  expect(skillBody('\uFEFF---\na: 1\n---\n正文\n---\n还是正文')).toBe('正文\n---\n还是正文');
  expect(skillBody('没有前置块')).toBe('没有前置块');
  expect(skillBody('---\na: 1\n没有结束')).toBe('');
});
it('skillBody: an empty front matter, a closing line that is a whole line, and a body that opens with a rule', () => {
  expect(skillBody('---\n---\n正文')).toBe('正文');
  expect(skillBody('---\na: 1\n----\nb: 2\n---\n正文')).toBe('正文');
  expect(skillBody('---\na: 1\n---xyz\n---\n正文')).toBe('正文');
  expect(skillBody('---\na: 1\n---')).toBe('');
  expect(skillBody('正文\n---\n还有')).toBe('正文\n---\n还有');
});
it('the lower and upper body limits are exact', async () => {
  const body = (n: number) => admin({ data: b64(`---\nname: x\n---\n${'a'.repeat(n)}`), error: null });
  expect(await loadCoachMethod(body(MIN_COACH_METHOD_BYTES - 1), env)).toEqual({ ok: false, reason: 'TOO_SHORT' });
  expect(await loadCoachMethod(body(MIN_COACH_METHOD_BYTES), env)).toMatchObject({ ok: true });
});
