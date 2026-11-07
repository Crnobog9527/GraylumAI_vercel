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
  it.each(['', 'lang=zh-Hans', 'action=signup'])('opens on 手机号 with two separate consent boxes for ?%s', (query) => {
    params.current = new URLSearchParams(query);
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>手机号/);
    expect(markup).toContain('>邮箱</button>');
    expect(markup).toContain('+86');
    expect(markup).toContain('name="privacyConsent"');
    expect(markup).toContain('name="transferConsent"');
    expect(markup).not.toMatch(/name="privacyConsent"[^>]*checked/);
    expect(markup).toContain('href="/privacy"');
    expect(markup).not.toContain('type="email"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>加载中\.\.\./);
  });

  it.each(['lang=zh-Hant', 'lang=en'])('shows no phone entry for ?%s', (query) => {
    params.current = new URLSearchParams(query);
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('+86');
    expect(markup).toContain('type="email"');
  });
});
