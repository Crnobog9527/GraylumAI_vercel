/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const params = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => params.current }));
vi.mock('@/trpc/client', () => ({
  trpc: { settings: { getSystemSettings: { useQuery: () => ({ data: undefined }) } } },
}));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn() }));

import { LoginPageContent } from './page';

// Invitation rewards were retired (Owner 2026-10-14): an old ?invite= link opens the ordinary form.
describe('/login with a retired invite link', () => {
  it.each([
    ['invite=OLDCODE', '登录', false],
    ['action=signup&invite=OLDCODE', '创建账户', true],
  ])('renders the normal form for ?%s without any invitation field', (query, submit, signup) => {
    params.current = new URLSearchParams(query);
    const markup = renderToStaticMarkup(createElement(LoginPageContent));
    expect(markup).toContain(`>${submit}`);
    expect(markup).toContain('type="email"');
    expect(markup.includes('id="nickname"')).toBe(signup);
    expect(markup).not.toContain('invite-code');
    expect(markup).not.toContain('邀请码');
  });
});
