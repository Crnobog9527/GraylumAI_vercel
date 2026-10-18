/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));

import { FounderBadgeView } from './FounderBadge';
import { FounderProfileCardView } from './FounderProfileCard';
import {
  buildSubmit, canEditCard, EMPTY_FORM, founderMemberError, showsBadge, showsCard, statusLine, wallStatus,
  type FounderMemberView, type FounderState,
} from './founderMemberView';

const view = (state: FounderState, over: Partial<FounderMemberView> = {}): FounderMemberView => ({
  founder: { state, deadline: null, endedReason: null }, consent: { currentVersion: 'fw-v1', granted: false },
  entry: null, listed: false, community: null, ...over,
});
const entry = { displayName: 'A', socialAccounts: [], productName: null, productUrl: null, intro: null, reviewState: 'pending' as const };
const render = (v: FounderMemberView) => renderToStaticMarkup(createElement(FounderProfileCardView,
  { view: v, pending: false, error: null, onSubmit: vi.fn(), onWithdraw: vi.fn() }));

describe('badge visibility', () => {
  it('shows only for active and grace; frozen and ended hide it', () => {
    expect(showsBadge('active')).toBe(true);
    expect(showsBadge('grace')).toBe(true);
    for (const state of ['frozen', 'ended', 'none'] as const) expect(showsBadge(state)).toBe(false);
    expect(renderToStaticMarkup(createElement(FounderBadgeView, { state: 'grace' }))).toContain('创始会员');
    expect(renderToStaticMarkup(createElement(FounderBadgeView, { state: 'frozen' }))).toBe('');
  });
  it('shows the card to members and to ended members who still have a card, never to non-members', () => {
    expect(showsCard(view('none'))).toBe(false);
    expect(showsCard(view('ended'))).toBe(false);
    expect(showsCard(view('ended', { entry }))).toBe(true);
    expect(showsCard(view('frozen'))).toBe(true);
    expect(showsCard(undefined)).toBe(false);
  });
});

describe('profile card', () => {
  it('active: badge, community entry, unticked consent form', () => {
    const html = render(view('active', { community: { url: 'https://example.test/g', note: '扫码入群' } }));
    expect(html).toContain('data-testid="founder-badge"');
    expect(html).toContain('扫码入群');
    expect(html).toContain('founder-wall-form');
    expect(html).not.toContain('aria-checked="true"');
    expect(html).not.toContain('founder-wall-withdraw');
  });
  it('frozen: no badge, no form, explains it is temporary', () => {
    const html = render(view('frozen'));
    expect(html).not.toContain('data-testid="founder-badge"');
    expect(html).not.toContain('founder-wall-form');
    expect(html).toContain('自动恢复');
  });
  it('ended with a card: taken down, no form, no badge', () => {
    const html = render(view('ended', { entry }));
    expect(html).toContain('卡片已下架');
    expect(html).not.toContain('founder-wall-form');
    expect(html).not.toContain('data-testid="founder-badge"');
  });
  it('consented card offers withdraw', () => {
    expect(render(view('active', { entry, consent: { currentVersion: 'fw-v1', granted: true } }))).toContain('founder-wall-withdraw');
  });
});

describe('wall helpers', () => {
  it('describes review state in plain words', () => {
    const base = view('active', { entry, consent: { currentVersion: 'fw-v1', granted: true } });
    expect(wallStatus(base)).toContain('待审核');
    expect(wallStatus({ ...base, entry: { ...entry, reviewState: 'approved' }, listed: true })).toContain('已展示');
    expect(wallStatus({ ...base, consent: { currentVersion: 'fw-v1', granted: false } })).toContain('已撤回');
    expect(canEditCard('frozen')).toBe(false);
    expect(statusLine(view('grace'))).toContain('宽限期');
  });
  it('refuses to submit without the opt-in tick and validates fields', () => {
    const filled = { ...EMPTY_FORM, displayName: ' 小明 ' };
    expect(buildSubmit(filled)).toEqual({ error: expect.stringContaining('愿意公开') });
    const ok = buildSubmit({ ...filled, consent: true });
    expect(ok).toMatchObject({ consentVersion: 'fw-v1', entry: { displayName: '小明', socialAccounts: [] } });
    expect(buildSubmit({ ...filled, consent: true, accounts: [{ platform: 'x', handle: 'a', url: '' }] })).toHaveProperty('error');
    expect(buildSubmit({ ...filled, consent: true, productUrl: 'https://a.test' })).toHaveProperty('error');
  });
  it('maps server codes to messages', () => {
    expect(founderMemberError({ message: 'x FOUNDER_WALL_LINK_INVALID y' })).toContain('https://');
    expect(founderMemberError({ message: 'FOUNDER_WALL_VERSION_STALE' })).toContain('刷新');
    expect(founderMemberError(null)).toContain('保存失败');
  });
});
