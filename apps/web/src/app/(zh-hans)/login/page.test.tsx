/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const params = vi.hoisted(() => ({ current: new URLSearchParams() }));
// Every tRPC router the page touches is recorded, so an invitation call (query, fetch or utils) cannot hide.
const routers = vi.hoisted(() => [] as string[]);
vi.mock('next/navigation', () => ({ useSearchParams: () => params.current }));
vi.mock('@/trpc/client', () => ({
  trpc: new Proxy({}, { get: (_target, router: string) => {
    routers.push(router);
    if (router === 'settings') return { getSystemSettings: { useQuery: () => ({ data: undefined }) } };
    throw new Error(`unexpected tRPC router: ${router}`);
  } }),
}));
const createClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ createClient }));

import { LoginPageContent } from './page';

// Invitation rewards were retired (Owner 2026-10-14): an old ?invite= link opens the ordinary form.
describe('/login with a retired invite link', () => {
  it.each([
    ['invite=OLDCODE&lang=zh-Hant', '登录', false],
    ['action=signup&invite=OLDCODE&lang=zh-Hant', '注册', true],
    ['action=login&lang=zh-Hant', '登录', false],
    ['action=signup&lang=zh-Hant', '注册', true],
  ])('renders the normal form for ?%s without any invitation field or request', (query, submit, signup) => {
    params.current = new URLSearchParams(query);
    routers.length = 0;
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).toContain(`>${submit}`);
    expect(markup).toContain('type="email"');
    // The server-rendered form cannot be submitted before the page's scripts have taken it over: its submit button is off and says so,
    // and a native submit would post, never put a field in the address.
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>加载中\.\.\./);
    expect(markup).toContain('method="post"');
    expect(markup.includes('id="nickname"')).toBe(signup);
    expect(markup).not.toContain('invite-code');
    expect(markup).not.toContain('邀请码');
    // No invitation endpoint is requested: the only router read is the system settings query.
    expect(routers).toEqual(['settings']);
    expect(createClient).not.toHaveBeenCalled();
  });
});

// PHONE-OTP (Owner 2026-11-07): the Simplified login page opens on the phone tab; the Taiwan entry (lang=zh-Hant) keeps email only.
describe('/login phone tab', () => {
  it.each(['', 'lang=zh-Hans', 'action=signup'])('opens on 手机号 with one box for the terms and the privacy policy for ?%s', (query) => {
    params.current = new URLSearchParams(query);
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>手机号/);
    expect(markup).toContain('>邮箱</button>');
    expect(markup).toContain('+86');
    // Owner 2026-11-13: one box, "我已阅读并同意《服务条款》和《隐私政策》", each name a link to its page; not ticked for the visitor.
    expect(markup.match(/type="checkbox"/g)).toHaveLength(1);
    expect(markup).toContain('name="termsPrivacyConsent"');
    expect(markup).not.toMatch(/name="termsPrivacyConsent"[^>]*checked/);
    expect(markup.replace(/<[^>]+>/g, '')).toContain('我已阅读并同意《服务条款》和《隐私政策》');
    expect(markup).toMatch(/<a[^>]*href="\/terms"[^>]*>《服务条款》<\/a>/);
    expect(markup).toMatch(/<a[^>]*href="\/privacy"[^>]*>《隐私政策》<\/a>/);
    // The box for sending personal information out of mainland China is not shown ("不要展示").
    expect(markup).not.toContain('transferConsent');
    expect(markup).not.toMatch(/出境|境外|传输到/);
    expect(markup).not.toContain('type="email"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>加载中\.\.\./);
  });

  it('opens the email tab for ?method=email and keeps the phone tab one click away', () => {
    params.current = new URLSearchParams('method=email');
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>邮箱/);
    expect(markup).toContain('>手机号</button>');
    expect(markup).toContain('type="email"');
    expect(markup).not.toContain('+86');
  });

  it.each(['lang=zh-Hant', 'lang=en'])('shows no phone entry for ?%s', (query) => {
    params.current = new URLSearchParams(query);
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('+86');
    expect(markup).toContain('type="email"');
  });
});
