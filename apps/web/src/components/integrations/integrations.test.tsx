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

  it('the introduction is said by Shotviva\'s sample pictures first: a phone photo and a template\'s result, then the same two per use', () => {
    const html = body(state({ available: true, eligible: true, connected: false, balance: null }));
    const pictures = [...html.matchAll(/<img src="\/integrations\/shotviva\/([a-z-]+)\.webp" alt="([^"]+)" width="(\d+)" height="(\d+)"/g)];
    expect(pictures.map(match => match[1])).toEqual(['coffee-phone', 'coffee-noir-bar', 'salad-phone', 'salad-forest-moss', 'tote-phone', 'tote-promo',
      'room-phone', 'room-staged', 'dress-phone', 'dress-white', 'hair-phone', 'hair-cutout', 'poster-before', 'poster-after']);
    // Every picture keeps its box (4:5) before it arrives. (When each is fetched is measured in the browser test.)
    expect(html.match(/<img src="\/integrations\/shotviva\//g)?.length).toBe(pictures.length);
    for (const match of pictures) expect(Number(match[3]) / Number(match[4]), match[1]).toBe(0.8);
    for (const words of ['手机拍的照片', '选一个模板后', '菜品图', '商品图', '房源图', '一键白底图', '一键抠图', '精准编辑图片文字']) {
      expect(html).toContain(`>${words}<`);
    }
    // The pictures of 能做什么 come before its words, and those of 什么时候适合用 before its two lines.
    expect(html.indexOf('coffee-noir-bar')).toBeLessThan(html.indexOf('每个模板都保留你拍的主体'));
    expect(html.indexOf('poster-after')).toBeLessThan(html.indexOf('一次上新很多商品'));
    // What the poster in the last picture says is the picture's: no date or discount in words.
    expect(html.replace(/<[^>]+>/g, '')).not.toMatch(/折|月\s*\d|\d\s*日/);
  });

  it('not a member: no connect button, the membership page instead; connector off: no connect button either', () => {
    const members = body(state({ available: true, eligible: false, connected: false, balance: null }));
    expect(members).toContain('Pro 和 Gold 会员');
    expect(members).toContain('href="/app/profile?tab=subscription"');
    expect(members).not.toContain('>连接 Shotviva<');
    expect(body(state({ available: false, eligible: true, connected: false, balance: null }))).not.toContain('>连接 Shotviva<');
  });

  it('connected: both kinds of credits by name (a zero too), Shotviva\'s own top-up page and 断开', () => {
    const words = (html: string) => html.replace(/<[^>]+>/g, '');
    const html = body(state({ available: true, eligible: true, connected: true,
      balance: { credits: 12, freeCredits: 3, paidUntil: null, topUpUrl: 'https://shotviva.com/pricing?from=graylum' } }));
    // Owner 2026-11-13: "现在显示了'3 积分'，这其实是付费积分，但是你没写'付费积分'，用户会迷惑的。"
    expect(words(html)).toContain('已连接：付费积分 12 · 免费积分 3');
    expect(words(html)).not.toMatch(/剩余 \d+ 积分|另有/);
    expect(html).toContain('href="https://shotviva.com/pricing?from=graylum"');
    expect(html).toContain('>断开<');
    expect(html).not.toContain('>连接 Shotviva<');
    const balance = (credits: number, freeCredits: number) => words(body(state({ available: true, eligible: true, connected: true,
      balance: { credits, freeCredits, paidUntil: null, topUpUrl: null } })));
    expect(balance(3, 0)).toContain('已连接：付费积分 3 · 免费积分 0');
    expect(balance(0, 5)).toContain('已连接：付费积分 0 · 免费积分 5');
    expect(balance(0, 0)).toContain('已连接：付费积分 0 · 免费积分 0');
    // A number of credits never stands without its name.
    for (const text of [balance(3, 0), balance(0, 5)]) expect(text).not.toMatch(/(?<!付费|免费)积分 \d/);
    expect(body(state({ available: true, eligible: true, connected: true, balance: null }))).toContain('剩余积分暂时读取不了');
    expect(balance(1, 0)).not.toContain('去 Shotviva 充值');
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
