/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The profile page's 工单 tab in a real browser: the page and the real ticket panel together, the server calls and the
// unrelated cards replaced. The bug this guards (2026-01-15 to 2026-11-12): the page keyed the panel on the view the
// panel reported, so opening a ticket remounted the panel and dropped the user back on the list. Neither half shows it
// alone, which is why the page's static-markup test (TicketsPanel mocked away) never could.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__profile_tickets_fixture__.js', import.meta.url));
const nothing = (...names: string[]) => names.map(name => `export const ${name} = () => null;`).join('\n');
const STUBS: Record<string, string> = {
  // The address is the source of the tab, as in the app: Next keeps useSearchParams in step with history.replaceState.
  'next/navigation': `
    import { useSyncExternalStore } from 'react';
    const listeners = new Set();
    const replace = window.history.replaceState.bind(window.history);
    window.history.replaceState = (...args) => { replace(...args); listeners.forEach(listener => listener()); };
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search));
  `,
  '@/trpc/client': `
    const ticket = over => ({ id: 't1', ticket_number: 'TK-0001', title: '申请退款', description: '买错了套餐', category: 'billing',
      status: 'pending', created_at: '2026-11-01T02:03:00Z', attachments: [], replies: [], ...over });
    const tickets = [ticket({}), ticket({ id: 't2', ticket_number: 'TK-0002', title: '登录问题', category: 'other', status: 'in_progress' }),
      ticket({ id: 't3', ticket_number: 'TK-0003', title: '旧的问题', category: 'other', status: 'closed',
        replies: [{ id: 'r1', message: '已经处理好了', is_admin_reply: true, attachments: [], created_at: '2026-10-02T00:00:00Z' }] })];
    window.calls = []; window.refetches = 0;
    const mutation = name => ({ useMutation: options => ({ isPending: false, mutate: input => {
      window.calls.push([name, input]); void options?.onSuccess?.({}, input);
    } }) });
    export const trpc = {
      user: { getUserProfile: { useQuery: () => ({ data: { id: 'u1', email: 'a@example.com', nickname: '小王',
        membership_level: 'pro', created_at: '2026-01-01' }, isLoading: false, error: null, isFetching: false, refetch: () => {} }) } },
      credits: { getCreditsSummary: { useQuery: () => ({ data: undefined, isLoading: true, isError: false }) } },
      ticket: {
        getTickets: { useQuery: () => ({ data: tickets, isLoading: false, error: null, refetch: async () => { window.refetches++; } }) },
        replyToTicket: mutation('replyToTicket'), closeTicket: mutation('closeTicket'), createTicket: mutation('createTicket'),
      },
    };
  `,
  '@/hooks/use-credits': `export const useCreditsBalance = () => ({ credits: 10, status: 'ready', isLoading: false, error: null, refetch() {} });`,
  '@/hooks/use-banner': `export const useBanner = () => ({ banners: [] });`,
  '@/hooks/use-profile-prefetch': `export const useProfilePrefetch = () => undefined;`,
  '@/hooks/use-ticket-attachments': `export const useTicketAttachments = () => ({ attachments: [], uploading: false, uploadError: null,
    handleFileUpload() {}, removeAttachment() {} });`,
  '@/components/profile/ProfileShell': `export const ProfileShell = ({ children }) => children;`,
  '@/components/layout/GlobalBanner': `export default () => null;`,
  '@/components/profile/ProfileSidebar': `export default () => null;`,
  '@/components/profile/PersonalInfoCard': `
    import { createElement } from 'react';
    ${nothing('UserProfileHeader', 'CreditsAndSubscriptionCards', 'UsageStatsCard')}
    export const QuickActionsCard = ({ onNavigateToTickets }) => createElement('button', { onClick: onNavigateToTickets }, '联系客服');
  `,
  '@/components/profile/SubscriptionCard': nothing('SubscriptionCard', 'CreditStatsCard'),
  '@/components/profile/BillingRecordsCard': `export default () => null;`,
  '@/components/profile/PaymentNoticeInbox': nothing('PaymentNoticeInbox'),
  '@/components/profile/PaymentDisputeNotice': nothing('PaymentDisputeNotice'),
  '@/components/profile/CreditRecordsCard': nothing('CreditRecordsCard'),
  '@/components/profile/SecuritySettingsCard': nothing('SecuritySettingsCard'),
  '@/components/profile/AccountErasureCard': nothing('AccountErasureCard'),
  '@/components/profile/DataUseConsentCard': nothing('DataUseConsentCard'),
  '@/components/profile/dataUseConsentVisibility': `export const DATA_USE_CONSENT_VISIBLE = false;`,
  '@/components/founder/FounderProfileCard': nothing('FounderProfileCard'),
  '@/components/analytics/CookieSettingsCard': nothing('CookieSettingsCard'),
};
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../', import.meta.url)) } },
    plugins: [{ name: 'profile-tickets-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id in STUBS) return `\0stub:${id}`;
    }, load(id: string) {
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Page from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ProfileTicketsTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open(search: string) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // A real origin, so the page can rewrite its own address when it changes tab; nothing leaves the machine.
  await page.route('**/*', route => (route.request().url().startsWith('https://profile.test/app/profile')
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }) : route.abort()));
  await page.goto(`https://profile.test/app/profile${search}`);
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const cards = (page: Page) => page.getByTestId('ticket-list-item');
const detail = (page: Page) => page.getByTestId('ticket-detail-view');
const calls = (page: Page) => page.evaluate('window.calls') as Promise<[string, unknown][]>;

it('a ticket card opens its details; a reply is sent from there; back returns to the list', async () => {
  const { page, errors } = await open('?tab=tickets');
  try {
    await browserExpect(cards(page)).toHaveCount(2);
    await cards(page).filter({ hasText: '申请退款' }).click();
    await browserExpect(detail(page)).toBeVisible();
    await browserExpect(detail(page)).toContainText('TK-0001');
    await browserExpect(detail(page)).toContainText('买错了套餐');
    await browserExpect(cards(page)).toHaveCount(0);

    await detail(page).getByPlaceholder('输入您的回复...').fill(' 请尽快处理 ');
    await detail(page).getByRole('button', { name: '发送回复' }).click();
    expect(await calls(page)).toEqual([['replyToTicket', { ticketId: 't1', content: '请尽快处理' }]]);
    expect(await page.evaluate('window.refetches')).toBe(1);
    // still on the ticket after the reply, with the box emptied
    await browserExpect(detail(page)).toContainText('TK-0001');
    await browserExpect(detail(page).getByPlaceholder('输入您的回复...')).toHaveValue('');

    await detail(page).getByRole('button', { name: '返回工单列表' }).click();
    await browserExpect(detail(page)).toHaveCount(0);
    await browserExpect(cards(page)).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('back from a closed ticket stays on 已关闭; closing a ticket returns to the list', async () => {
  const { page, errors } = await open('?tab=tickets');
  try {
    await page.getByRole('button', { name: /已关闭/ }).click();
    await browserExpect(cards(page)).toHaveCount(1);
    await cards(page).click();
    await browserExpect(detail(page)).toContainText('旧的问题');
    await browserExpect(detail(page)).toContainText('已经处理好了');
    await browserExpect(detail(page)).toContainText('此工单已关闭');
    await detail(page).getByRole('button', { name: '返回工单列表' }).click();
    // the tab the user came from, not the default one
    await browserExpect(cards(page)).toHaveCount(1);
    await browserExpect(cards(page)).toContainText('旧的问题');

    await page.getByRole('button', { name: /现有工单/ }).click();
    await cards(page).filter({ hasText: '登录问题' }).click();
    await detail(page).getByRole('button', { name: '关闭工单' }).click();
    expect(await calls(page)).toEqual([['closeTicket', { ticketId: 't2' }]]);
    await browserExpect(detail(page)).toHaveCount(0);
    await browserExpect(cards(page)).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('创建工单 opens the form, both from the list and from the profile tab; a created ticket lands on 现有工单', async () => {
  const { page, errors } = await open('');
  try {
    // from the profile tab's shortcut: the tab changes and the form is what opens
    await page.getByRole('button', { name: '联系客服' }).click();
    await browserExpect(page.getByText('创建新工单')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('tab')).toBe('tickets');
    await page.getByRole('button', { name: '返回工单列表' }).click();
    await browserExpect(cards(page)).toHaveCount(2);

    // from the list, while looking at the closed ones
    await page.getByRole('button', { name: /已关闭/ }).click();
    await page.getByTestId('ticket-create-button').click();
    await page.getByPlaceholder('简要描述您的问题').fill('新的问题');
    await page.getByPlaceholder('请详细描述您遇到的问题...').fill('说明');
    await page.getByRole('button', { name: '提交工单' }).click();
    expect((await calls(page))[0][0]).toBe('createTicket');
    expect((await calls(page))[0][1]).toMatchObject({ title: '新的问题', description: '说明', attachments: [] });
    await browserExpect(page.getByText('创建新工单')).toHaveCount(0);
    // the new ticket is an open one: the list shows the open ones so it can be seen
    await browserExpect(cards(page)).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('a card carries no inline border, so its hover border colour can apply', async () => {
  const { page } = await open('?tab=tickets');
  try {
    const card = cards(page).first();
    await browserExpect(card).toHaveClass(/hover:border-\[rgba\(255,215,0,0\.3\)\]/);
    expect(await card.evaluate(element => (element as HTMLElement).style.border)).toBe('');
    expect(await card.evaluate(element => (element as HTMLElement).style.borderColor)).toBe('');
  } finally { await page.close(); }
}, 30000);
