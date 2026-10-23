/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { addAccount: { useMutation: () => ({ error: null, isPending: false, mutate: vi.fn() }) } } } }));
import { ADD_PLATFORMS, AddAccountForm } from './AddAccountForm';
import { dataErrorMessage } from './labels';

const brand = (businessId: string, name: string) => ({ businessId, name, accounts: [] });

it('says to confirm a positioning first when the user has no positioning profile (none is created here)', () => {
  const html = renderToStaticMarkup(<AddAccountForm brands={[]} onAdded={() => {}} />);
  expect(html).toContain('完成并确认一个定位');
  expect(html).not.toContain('<select');
});

it('lists the connectable platforms (not TikTok Business) and asks for the profile only when there are several', () => {
  expect(ADD_PLATFORMS).not.toContain('tiktok_business');
  const one = renderToStaticMarkup(<AddAccountForm brands={[brand('a', '品牌甲')]} onAdded={() => {}} />);
  expect(one).not.toContain('选择定位档案');
  for (const name of ['X', 'YouTube', 'Instagram', '小红书', '抖音']) expect(one).toContain(name);
  const two = renderToStaticMarkup(<AddAccountForm brands={[brand('a', '品牌甲'), brand('b', '品牌乙')]} onAdded={() => {}} />);
  expect(two).toContain('选择定位档案');
});

it('every refusal of the database has its own readable text', () => {
  for (const code of ['PUBLISH_MONITOR_BUSINESS_NOT_READY', 'PUBLISH_MONITOR_PLATFORM_HAS_ACCOUNT',
    'PUBLISH_MONITOR_ACCOUNT_EXISTS_ELSEWHERE', 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND']) {
    expect(dataErrorMessage(code)).not.toBe('暂时读不到，请稍后重试。');
  }
});
