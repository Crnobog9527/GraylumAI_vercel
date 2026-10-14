/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { canonicalAccount, parseProfileLink, profileLinksIn } from '../accountLinks';
import { authorizeBenchmarkFetch, authorizeDiscoverStart, type AuthorizationStore } from '../authorize';
import { researchToolArgs } from '../schemas';

const scope = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002' };
const ids = {
  candidate: '00000000-0000-4000-8000-000000000010',
  message: '00000000-0000-4000-8000-000000000011',
  refresh: '00000000-0000-4000-8000-000000000012',
  keywords: '00000000-0000-4000-8000-000000000013',
  other: '00000000-0000-4000-8000-000000000099',
};

/** Only records for `scope` and the known ids exist; anything else (other user, session or id) is null. */
function store(overrides: Partial<{ used: boolean; message: string }> = {}): AuthorizationStore {
  const mine = (s: typeof scope) => s.userId === scope.userId && s.sessionId === scope.sessionId;
  return {
    keywordConfirmation: vi.fn(async (s, id) => (mine(s) && id === ids.keywords ? { keywords: ['家居收纳', '租房改造', '小户型'] } : null)),
    candidateConfirmation: vi.fn(async (s, id) => (mine(s) && id === ids.candidate
      ? [{ platform: 'tiktok' as const, account: 'homeideas' }, { platform: 'x' as const, account: 'tidyroom' }] : null)),
    userMessage: vi.fn(async (s, id) => (mine(s) && id === ids.message
      ? overrides.message ?? '对标账号：https://www.tiktok.com/@HomeIdeas?lang=en 还有 https://x.com/TidyRoom/ ' : null)),
    refreshGrant: vi.fn(async (s, id) => (mine(s) && id === ids.refresh
      ? { platform: 'tiktok' as const, account: 'homeideas', used: overrides.used ?? false } : null)),
  };
}

const fetchArgs = (accounts: Array<{ platform: string; account: string }>, source: unknown) =>
  researchToolArgs.benchmark_fetch.parse({ accounts, source });

describe('profile links', () => {
  it('normalises supported profile links and rejects everything else', () => {
    expect(parseProfileLink('https://www.tiktok.com/@Home.Ideas')).toEqual({ platform: 'tiktok', account: 'home.ideas' });
    expect(parseProfileLink('https://twitter.com/TidyRoom')).toEqual({ platform: 'x', account: 'tidyroom' });
    expect(parseProfileLink('https://www.instagram.com/tidy_room/')).toEqual({ platform: 'instagram', account: 'tidy_room' });
    expect(parseProfileLink('https://space.bilibili.com/123456')).toEqual({ platform: 'bilibili', account: '123456' });
    expect(parseProfileLink('https://weibo.com/u/7654321')).toEqual({ platform: 'weibo', account: '7654321' });
    expect(parseProfileLink('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'))
      .toEqual({ platform: 'youtube', account: 'UCabcdefghijklmnopqrstuv' });
    for (const link of ['https://x.com/home', 'https://www.instagram.com/p/abc', 'https://www.tiktok.com/discover',
      'https://www.youtube.com/@someone', 'https://www.douyin.com/user/abc', 'https://evil.example/@homeideas',
      'https://user:pw@x.com/tidyroom', 'ftp://x.com/tidyroom', 'https://x.com/%E0%A4%A',
      'https://x.com/tidyroom/status/123', 'https://www.tiktok.com/@homeideas/video/1', 'https://www.instagram.com/tidy_room/reels',
      'https://space.bilibili.com/123456/video', 'https://weibo.com/u/7654321/home',
      'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos', 'https://x.com:4444/tidyroom']) {
      expect(parseProfileLink(link)).toBeNull();
    }
  });

  it('accepts bare ids, @handles and links for the model argument', () => {
    expect(canonicalAccount('tiktok', '@HomeIdeas')).toBe('homeideas');
    expect(canonicalAccount('tiktok', 'https://www.tiktok.com/@homeideas')).toBe('homeideas');
    expect(canonicalAccount('tiktok', 'https://x.com/homeideas')).toBeNull();
    expect(canonicalAccount('bilibili', '12a')).toBeNull();
  });

  it('drops sentence punctuation after a link', () => {
    expect(profileLinksIn('My benchmark is https://x.com/alice. Also https://www.tiktok.com/@bob.c, and https://x.com/carol; https://x.com/dan!'))
      .toEqual([{ platform: 'x', account: 'alice' }, { platform: 'tiktok', account: 'bob.c' },
        { platform: 'x', account: 'carol' }, { platform: 'x', account: 'dan' }]);
  });

  it('lists distinct profile links in order, ignoring plain mentions', () => {
    expect(profileLinksIn('看 @homeideas 和 https://x.com/A_b，还有 https://x.com/a_B 以及 https://tiktok.com/@zz9'))
      .toEqual([{ platform: 'x', account: 'a_b' }, { platform: 'tiktok', account: 'zz9' }]);
  });
});

describe('benchmark_fetch authorization', () => {
  it('accepts accounts from a confirmed candidate card', async () => {
    const result = await authorizeBenchmarkFetch(scope,
      fetchArgs([{ platform: 'tiktok', account: '@HomeIdeas' }], { kind: 'candidate', confirmationId: ids.candidate }), store());
    expect(result).toMatchObject({ ok: true, accounts: [{ platform: 'tiktok', account: 'homeideas' }] });
  });

  it('rejects an unselected candidate, an invented account and another session\'s confirmation', async () => {
    const s = store();
    const unselected = fetchArgs([{ platform: 'tiktok', account: 'homeideas' }, { platform: 'tiktok', account: 'notchosen' }],
      { kind: 'candidate', confirmationId: ids.candidate });
    expect(await authorizeBenchmarkFetch(scope, unselected, s)).toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
    const otherSession = { ...scope, sessionId: ids.other };
    const valid = fetchArgs([{ platform: 'tiktok', account: 'homeideas' }], { kind: 'candidate', confirmationId: ids.candidate });
    expect(await authorizeBenchmarkFetch(otherSession, valid, s)).toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
    const otherUser = { ...scope, userId: ids.other };
    expect(await authorizeBenchmarkFetch(otherUser, valid, s)).toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
  });

  it('accepts only whole profile links from the user\'s message, on the same platform', async () => {
    const s = store();
    const ok = fetchArgs([{ platform: 'tiktok', account: 'homeideas' }, { platform: 'x', account: 'TidyRoom' }],
      { kind: 'user_message', messageId: ids.message });
    expect(await authorizeBenchmarkFetch(scope, ok, s)).toMatchObject({ ok: true });
    for (const account of [{ platform: 'tiktok', account: 'ho' }, { platform: 'tiktok', account: 'tidyroom' },
      { platform: 'instagram', account: 'homeideas' }]) {
      const args = fetchArgs([account], { kind: 'user_message', messageId: ids.message });
      expect(await authorizeBenchmarkFetch(scope, args, s)).toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
    }
  });

  it('does not treat a post link as confirming its author', async () => {
    const args = fetchArgs([{ platform: 'x', account: 'tidyroom' }], { kind: 'user_message', messageId: ids.message });
    expect(await authorizeBenchmarkFetch(scope, args, store({ message: '看这条 https://x.com/TidyRoom/status/123' })))
      .toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
  });

  it('ignores a bare account name without a link', async () => {
    const args = fetchArgs([{ platform: 'tiktok', account: 'homeideas' }], { kind: 'user_message', messageId: ids.message });
    expect(await authorizeBenchmarkFetch(scope, args, store({ message: '我的对标是 tiktok 上的 homeideas' })))
      .toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
  });

  it('uses a refresh grant once, for its own account only', async () => {
    const args = fetchArgs([{ platform: 'tiktok', account: 'homeideas' }], { kind: 'refresh', refreshId: ids.refresh });
    expect(await authorizeBenchmarkFetch(scope, args, store())).toMatchObject({ ok: true });
    expect(await authorizeBenchmarkFetch(scope, args, store({ used: true }))).toEqual({ ok: false, reason: 'REFRESH_USED' });
    const other = fetchArgs([{ platform: 'tiktok', account: 'someoneelse' }], { kind: 'refresh', refreshId: ids.refresh });
    expect(await authorizeBenchmarkFetch(scope, other, store())).toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
    const two = fetchArgs([{ platform: 'tiktok', account: 'homeideas' }, { platform: 'x', account: 'tidyroom' }],
      { kind: 'refresh', refreshId: ids.refresh });
    expect(await authorizeBenchmarkFetch(scope, two, store())).toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
  });

  it('rejects malformed and duplicate accounts before reading any record', async () => {
    const s = store();
    const bad = fetchArgs([{ platform: 'x', account: 'not a handle!' }], { kind: 'candidate', confirmationId: ids.candidate });
    expect(await authorizeBenchmarkFetch(scope, bad, s)).toEqual({ ok: false, reason: 'ACCOUNT_INVALID' });
    const dup = fetchArgs([{ platform: 'x', account: 'TidyRoom' }, { platform: 'x', account: '@tidyroom' }],
      { kind: 'candidate', confirmationId: ids.candidate });
    expect(await authorizeBenchmarkFetch(scope, dup, s)).toEqual({ ok: false, reason: 'DUPLICATE_ACCOUNT' });
    expect(s.candidateConfirmation).not.toHaveBeenCalled();
  });
});

describe('benchmark_discover authorization', () => {
  it('takes keywords from the confirmation record only', async () => {
    expect(await authorizeDiscoverStart(scope, { keywordConfirmationId: ids.keywords, platforms: ['tiktok'] }, store()))
      .toEqual({ ok: true, keywords: ['家居收纳', '租房改造', '小户型'], platforms: ['tiktok'] });
    expect(await authorizeDiscoverStart({ ...scope, userId: ids.other }, { keywordConfirmationId: ids.keywords, platforms: ['tiktok'] }, store()))
      .toEqual({ ok: false, reason: 'NOT_CONFIRMED' });
  });
});
