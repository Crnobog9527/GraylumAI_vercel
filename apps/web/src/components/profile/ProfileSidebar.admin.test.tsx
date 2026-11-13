/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/founder/FounderBadge', () => ({ FounderBadge: () => null }));
vi.mock('./profile-menu', async (importActual) => ({
  ...(await importActual<typeof import('./profile-menu')>()),
  useProfileLogout: () => ({ pending: false, run: vi.fn() }),
}));

import ProfileSidebar from './ProfileSidebar';

// Owner 2026-11-13: the profile center's menu carries the admin console's link for admins only.
describe('ProfileSidebar admin console entry', () => {
  it('links an admin to /admin', () => {
    const html = renderToStaticMarkup(<ProfileSidebar activeTab="profile" onTabChange={() => {}} isAdmin />);
    expect(html).toContain('data-testid="profile-admin-entry"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain('管理后台');
  });

  it('shows nothing of it to anyone else', () => {
    const html = renderToStaticMarkup(<ProfileSidebar activeTab="profile" onTabChange={() => {}} />);
    expect(html).not.toContain('/admin');
    expect(html).not.toContain('管理后台');
  });
});
