/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ list: { data: undefined as unknown, isLoading: false, error: null as unknown } }));
vi.mock('@/trpc/client', () => ({ trpc: {
  opc: { businesses: { useQuery: () => state.list } },
  publishMonitor: { addAccount: { useMutation: () => ({ error: null, isPending: false, mutate: vi.fn() }) } } } }));
import { ADD_PLATFORMS, AddAccountForm, eligibleProfiles, profileLabels } from './AddAccountForm';
import { dataErrorMessage } from './labels';

const profile = (businessId: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ businessId, name, isArchived: false, currentSourceVersionId: '00000000-0000-4000-8000-000000000001', ...extra });
beforeEach(() => { state.list = { data: [], isLoading: false, error: null }; });

it('only live profiles with a confirmed positioning are offered (archived and unconfirmed ones are not)', () => {
  expect(eligibleProfiles([profile('a', '甲'), profile('b', '乙', { isArchived: true }),
    profile('c', '丙', { currentSourceVersionId: null }), profile('d', '')]))
    .toEqual([{ businessId: 'a', name: '甲', createdAt: '' }, { businessId: 'd', name: '未命名定位档案', createdAt: '' }]);
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

it('profiles with the same name are told apart by creation date, and by a short code when the date matches too', () => {
  const p = (businessId: string, name: string, createdAt: string) => ({ businessId, name, createdAt });
  const labels = profileLabels([p('2d23c4ff-0000', '未命名业务', '2026-10-03T17:23:49Z'), p('b861f81a-0000', '未命名业务', '2026-10-09T17:09:58Z'),
    p('aaaa1111-0000', '独一份', '2026-10-01T00:00:00Z')]);
  expect(labels.get('2d23c4ff-0000')).toBe('未命名业务（创建于 2026-10-03）');
  expect(labels.get('b861f81a-0000')).toBe('未命名业务（创建于 2026-10-09）');
  expect(labels.get('aaaa1111-0000')).toBe('独一份');
  const same = profileLabels([p('abcd0000', '乙', '2026-10-03T01:00:00Z'), p('ef010000', '乙', '2026-10-03T09:00:00Z')]);
  expect(same.get('abcd0000')).toBe('乙（创建于 2026-10-03 #abcd）');
  expect(same.get('ef010000')).toBe('乙（创建于 2026-10-03 #ef01）');
});
