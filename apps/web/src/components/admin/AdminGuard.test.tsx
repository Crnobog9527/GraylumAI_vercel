/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/admin/settings' }));
vi.mock('@/trpc/client', () => ({ trpc: { admin: { getStatistics: { useQuery: () => state.result } } } }));
vi.mock('./AdminSidebar', () => ({ default: () => <nav>admin-sidebar</nav>, getAdminPageMeta: () => ({ title: '系统设置' }) }));

const { default: AdminGuard } = await import('./AdminGuard');
const render = () => renderToStaticMarkup(<AdminGuard><p>membership-permissions</p></AdminGuard>);

describe('admin settings are only rendered for admins', () => {
  it('does not render the settings for a signed-in non-admin', () => {
    state.result = { data: undefined, isLoading: false, error: { message: 'Admin role required', data: { code: 'FORBIDDEN' } } };
    const html = render();
    expect(html).not.toContain('membership-permissions');
    expect(html).not.toContain('admin-sidebar');
  });

  it('does not render the settings while the check is pending', () => {
    state.result = { data: undefined, isLoading: true, error: null };
    expect(render()).not.toContain('membership-permissions');
  });

  it('renders the settings for an admin', () => {
    state.result = { data: {}, isLoading: false, error: null };
    expect(render()).toContain('membership-permissions');
  });
});
