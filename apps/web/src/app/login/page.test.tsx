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
    ['invite=OLDCODE', '登录', false],
    ['action=signup&invite=OLDCODE', '创建账户', true],
    ['action=login', '登录', false],
    ['action=signup', '创建账户', true],
  ])('renders the normal form for ?%s without any invitation field or request', (query, submit, signup) => {
    params.current = new URLSearchParams(query);
    routers.length = 0;
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).toContain(`>${submit}`);
    expect(markup).toContain('type="email"');
    expect(markup.includes('id="nickname"')).toBe(signup);
    expect(markup).not.toContain('invite-code');
    expect(markup).not.toContain('邀请码');
    // No invitation endpoint is requested: the only router read is the system settings query.
    expect(routers).toEqual(['settings']);
    expect(createClient).not.toHaveBeenCalled();
  });
});
