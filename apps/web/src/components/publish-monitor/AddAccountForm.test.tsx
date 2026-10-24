/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ list: { data: undefined as unknown, isLoading: false, error: null as unknown } }));
vi.mock('@/trpc/client', () => ({ trpc: {
  opc: { businesses: { useQuery: () => state.list } },
  publishMonitor: { addAccount: { useMutation: () => ({ error: null, isPending: false, mutate: vi.fn() }) } } } }));
import { ADD_PLATFORMS, AddAccountForm, eligibleProfiles } from './AddAccountForm';
import { dataErrorMessage } from './labels';

const profile = (businessId: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ businessId, name, isArchived: false, currentSourceVersionId: '00000000-0000-4000-8000-000000000001', ...extra });
beforeEach(() => { state.list = { data: [], isLoading: false, error: null }; });

it('only live profiles with a confirmed positioning are offered (archived and unconfirmed ones are not)', () => {
  expect(eligibleProfiles([profile('a', '甲'), profile('b', '乙', { isArchived: true }),
    profile('c', '丙', { currentSourceVersionId: null }), profile('d', '')]))
    .toEqual([{ businessId: 'a', name: '甲' }, { businessId: 'd', name: '未命名定位档案' }]);
  expect(eligibleProfiles(undefined)).toEqual([]);
});

it('says to confirm a positioning first when no profile qualifies (none is created here)', () => {
  state.list = { data: [profile('c', '丙', { currentSourceVersionId: null }), profile('b', '乙', { isArchived: true })],
    isLoading: false, error: null };
  const html = renderToStaticMarkup(<AddAccountForm onAdded={() => {}} />);
  expect(html).toContain('完成并确认一个定位');
  expect(html).not.toContain('<select');
  state.list = { data: undefined, isLoading: false, error: new Error('x') };
  expect(renderToStaticMarkup(<AddAccountForm onAdded={() => {}} />)).toContain('暂时读不到你的定位档案');
});

it('lists the connectable platforms (not TikTok Business) and asks for the profile only when there are several', () => {
  expect(ADD_PLATFORMS).not.toContain('tiktok_business');
  state.list = { data: [profile('a', '甲')], isLoading: false, error: null };
  const one = renderToStaticMarkup(<AddAccountForm onAdded={() => {}} />);
  expect(one).not.toContain('选择定位档案');
  for (const name of ['X', 'YouTube', 'Instagram', '小红书', '抖音']) expect(one).toContain(name);
  state.list = { data: [profile('a', '甲'), profile('b', '乙')], isLoading: false, error: null };
  expect(renderToStaticMarkup(<AddAccountForm onAdded={() => {}} />)).toContain('选择定位档案');
});

it('every refusal of the database has its own readable text', () => {
  for (const code of ['PUBLISH_MONITOR_BUSINESS_NOT_READY', 'PUBLISH_MONITOR_PLATFORM_HAS_ACCOUNT',
    'PUBLISH_MONITOR_ACCOUNT_EXISTS_ELSEWHERE', 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND']) {
    expect(dataErrorMessage(code)).not.toBe('暂时读不到，请稍后重试。');
  }
});
