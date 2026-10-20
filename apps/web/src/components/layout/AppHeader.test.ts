/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn() }));
const { isNavItemActive, navItems } = await import('./AppHeader');

describe('logged-in header navigation (E1)', () => {
  it('sends 首页 to the logged-in home under /app, not the public home page', () => {
    expect(navItems.map(item => item.href)).toEqual(['/app', '/app/positioning', '/app/profile']);
    expect(navItems.some(item => item.href === '/')).toBe(false);
  });

  it('marks 首页 active only on /app itself, and the others on their pages and below', () => {
    expect(isNavItemActive('/app', '/app')).toBe(true);
    for (const path of ['/app/positioning', '/app/profile', '/app/library']) {
      expect(isNavItemActive(path, '/app'), path).toBe(false);
    }
    expect(isNavItemActive('/app/positioning', '/app/positioning')).toBe(true);
    expect(isNavItemActive('/app/positioning/draft-1/topics', '/app/positioning')).toBe(true);
    expect(isNavItemActive('/app/positioning-x', '/app/positioning')).toBe(false);
    expect(isNavItemActive('/app/profile', '/app/positioning')).toBe(false);
    expect(isNavItemActive('/', '/app')).toBe(false);
    expect(isNavItemActive(null, '/app')).toBe(false);
  });
});

describe('home links in logged-in screens (E1)', () => {
  it.each([
    'components/layout/AppHeader.tsx',
    'components/opc/workspace-frame.tsx',
    'components/opc/rail-view.tsx',
    'components/admin/AdminSidebar.tsx',
    'components/admin/AdminGuard.tsx',
    'app/access-denied/page.tsx',
    'app/app/page.tsx',
  ])('%s never sends a signed-in user to the public home page "/"', async file => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/href[=:]\s*\{?["'`]\/["'`]|push\(["'`]\/["'`]\)/);
  });
});
