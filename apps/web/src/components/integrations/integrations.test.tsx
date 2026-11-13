/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), disconnect: vi.fn() }));
vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ connectors: { shotvivaStatus: { invalidate: vi.fn() } } }),
  connectors: { shotvivaStatus: { useQuery: mocks.status }, shotvivaDisconnect: { useMutation: mocks.disconnect } } } }));
import { INTEGRATIONS } from '@/lib/integrations/catalog';
import { IntegrationDetailBody, IntegrationViewLink } from './IntegrationDetail';
import { IntegrationsView } from './IntegrationsView';
import type { ShotvivaState } from './use-shotviva';

const shotviva = INTEGRATIONS[0]!;
const state = (data: unknown, over: Partial<ShotvivaState> = {}) => ({ status: { data, isLoading: false }, connect: vi.fn(),
  connecting: false, error: null, disconnect: { mutate: vi.fn(), isPending: false, isError: false }, ...over }) as unknown as ShotvivaState;
// What the dialog shows under the product's own two paragraphs, and its foot.
const body = (s: ShotvivaState) => renderToStaticMarkup(<><IntegrationDetailBody module={shotviva} shotviva={s}/>
  <IntegrationViewLink module={shotviva} shotviva={s}/></>);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockReturnValue({ data: { available: true, eligible: true, connected: false, balance: null }, isLoading: false });
  mocks.disconnect.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
});

describe('the integrations page', () => {
  it('one card per module with its connection state; a connect result is said in words', () => {
    const html = renderToStaticMarkup(<IntegrationsView result={{ connected: 'connected' }}/>);
    expect(html).toContain('<h1>集成</h1>');
    expect(html).toContain('Shotviva');
    expect(html).toContain('未连接');
    expect(html).toContain('已连接 Shotviva');
    mocks.status.mockReturnValue({ data: { available: true, eligible: true, connected: true, balance: null }, isLoading: false });
    expect(renderToStaticMarkup(<IntegrationsView result={{ error: 'SHOTVIVA_CODE_INVALID' }}/>)).toContain('授权已过期');
    // A state that could not be read is not "未连接".
    mocks.status.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const failed = renderToStaticMarkup(<IntegrationsView result={{}}/>);
    expect(failed).toContain('状态读取失败');
    expect(failed).not.toContain('未连接');
  });

  it('the detail: what it does, when to use it, and 去查看 with the tracking, opening Shotviva in a new tab; no 去购买', () => {
    const html = body(state({ available: true, eligible: true, connected: false, balance: null }));
    for (const title of ['能做什么', '什么时候适合用', '连接到 Graylum 以后']) expect(html).toContain(title);
    expect(html).toContain('href="https://shotviva.com/zh?from=graylum&amp;utm_source=graylum&amp;utm_medium=integration&amp;utm_campaign=shotviva&amp;utm_content=view"');
    // The one link out: 去查看 (Owner 2026-11-13: "只保留'去查看'").
    expect(html.match(/target="_blank" rel="noopener noreferrer"/g)?.length).toBe(1);
    expect(html).toContain('>去查看<');
    expect(html).not.toContain('去购买');
    expect(html).not.toMatch(/utm_content=buy|shotviva\.com\/zh\/pricing/);
    expect(html).toContain('连接 Shotviva');
  });

  it('the introduction is said by Shotviva\'s sample pictures first: a phone photo and a template\'s result, then one picture per use', () => {
    const html = body(state({ available: true, eligible: true, connected: false, balance: null }));
    const pictures = [...html.matchAll(/<img src="(\/integrations\/shotviva\/[a-z-]+\.webp)" alt="([^"]+)"/g)].map(match => match[1]);
    expect(pictures).toEqual(['sneaker-phone', 'sneaker-lifestyle', 'sneaker-listing', 'menu-fish-dark', 'room-staged']
      .map(name => `/integrations/shotviva/${name}.webp`));
    for (const words of ['手机拍的照片', '选一个模板后', '商品图', '菜品图', '房源图', '开店', '做餐饮', '做民宿']) expect(html).toContain(`>${words}<`);
    // The pictures of 能做什么 come before its words, and those of 什么时候适合用 before its two lines.
    expect(html.indexOf('sneaker-lifestyle')).toBeLessThan(html.indexOf('每个模板都保留你拍的主体'));
    expect(html.indexOf('room-staged')).toBeLessThan(html.indexOf('一次上新很多商品'));
  });

  it('not a member: no connect button, the membership page instead; connector off: no connect button either', () => {
    const members = body(state({ available: true, eligible: false, connected: false, balance: null }));
    expect(members).toContain('Pro 和 Gold 会员');
    expect(members).toContain('href="/app/profile?tab=subscription"');
    expect(members).not.toContain('>连接 Shotviva<');
    expect(body(state({ available: false, eligible: true, connected: false, balance: null }))).not.toContain('>连接 Shotviva<');
  });

  it('connected: the balance, Shotviva\'s own top-up page and 断开', () => {
    const html = body(state({ available: true, eligible: true, connected: true,
      balance: { credits: 12, freeCredits: 3, paidUntil: null, topUpUrl: 'https://shotviva.com/pricing?from=graylum' } }));
    expect(html).toContain('已连接');
    expect(html).toContain('剩余 12 积分，另有 3 免费积分');
    expect(html).toContain('href="https://shotviva.com/pricing?from=graylum"');
    expect(html).toContain('>断开<');
    expect(html).not.toContain('>连接 Shotviva<');
    expect(body(state({ available: true, eligible: true, connected: true, balance: null }))).toContain('剩余积分暂时读取不了');
    expect(body(state({ available: true, eligible: true, connected: true,
      balance: { credits: 1, freeCredits: 0, paidUntil: null, topUpUrl: null } }))).not.toContain('去 Shotviva 充值');
  });

  it('a failed connect start says why in words', () => {
    const html = body(state({ available: true, eligible: true, connected: false, balance: null }, { error: 'Shotviva 暂时连接不上，请稍后再试。' }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Shotviva 暂时连接不上');
  });
});

describe('starting a connection', () => {
  it('posts to the connect route and goes only to an https address it answers; a refusal is said in words', async () => {
    const { startShotvivaConnect } = await import('./use-shotviva');
    const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const ok = reply(200, { url: 'https://shotviva.com/connect/graylum?state=s' });
    expect(await startShotvivaConnect(ok as never)).toEqual({ url: 'https://shotviva.com/connect/graylum?state=s' });
    expect(ok).toHaveBeenCalledWith('/api/connectors/shotviva/connect', { method: 'POST', credentials: 'same-origin' });
    for (const bad of ['javascript:alert(1)', 'http://shotviva.com/x', '/relative']) {
      expect(await startShotvivaConnect(reply(200, { url: bad }) as never)).toHaveProperty('message');
    }
    expect(await startShotvivaConnect(reply(403, { error: 'SHOTVIVA_MEMBERSHIP_REQUIRED' }) as never))
      .toEqual({ message: '连接 Shotviva 是 Pro 和 Gold 会员的功能。' });
    expect(await startShotvivaConnect(vi.fn(async () => { throw new Error('offline'); }) as never))
      .toEqual({ message: 'Shotviva 暂时连接不上，请稍后再试。' });
  });
});
