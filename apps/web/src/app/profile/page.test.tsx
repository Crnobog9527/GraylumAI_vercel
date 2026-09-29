/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  profile: {} as Record<string, unknown>,
  onTabChange: undefined as undefined | ((tab: string) => void),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => state.params }));
vi.mock('@/trpc/client', () => ({
  trpc: {
    user: { getUserProfile: { useQuery: () => state.profile } },
    credits: { getCreditsSummary: { useQuery: () => ({ data: { totalSpent: 1, totalEarned: 2 }, isLoading: false }) } },
  },
}));
vi.mock('@/hooks/use-credits', () => ({
  useCreditsBalance: () => ({ credits: 10, status: 'ready', isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/hooks/use-banner', () => ({ useBanner: () => ({ banners: [] }) }));
vi.mock('@/components/layout/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('@/components/layout/GlobalBanner', () => ({ default: () => null }));
vi.mock('@/components/profile/ProfileSidebar', () => ({
  default: ({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) => {
    state.onTabChange = onTabChange;
    return <nav data-active-tab={activeTab} />;
  },
}));
vi.mock('@/components/profile/PersonalInfoCard', () => ({
  UserProfileHeader: ({ user }: { user: { nickname: string; subscription_tier: string } }) => (
    <p>profile-header:{user.nickname}:{user.subscription_tier}</p>
  ),
  CreditsAndSubscriptionCards: () => null,
  UsageStatsCard: () => null,
  QuickActionsCard: () => null,
}));
vi.mock('@/components/profile/SubscriptionCard', () => ({ SubscriptionCard: () => <p>subscription-card</p>, CreditStatsCard: () => null }));
vi.mock('@/components/profile/BillingRecordsCard', () => ({ default: () => null }));
vi.mock('@/components/profile/CreditRecordsCard', () => ({ CreditRecordsCard: () => null }));
vi.mock('@/components/profile/UsageHistoryCard', () => ({ UsageHistoryCard: () => null }));
vi.mock('@/components/profile/SecuritySettingsCard', () => ({ SecuritySettingsCard: () => <p>security-card</p> }));
vi.mock('@/components/profile/TicketsPanel', () => ({ default: () => null }));

import ProfilePage from './page';

const realProfile = { id: 'u1', email: 'a@example.com', nickname: '小王', membership_level: 'pro', created_at: '2026-01-01' };

beforeEach(() => {
  state.params = new URLSearchParams();
  state.profile = { data: realProfile, isLoading: false, error: null, isFetching: false, refetch: vi.fn() };
});

describe('profile page', () => {
  it('shows an explicit failure instead of default membership or name when the profile read fails', () => {
    state.profile = { data: undefined, isLoading: false, error: { message: 'boom' }, isFetching: false, refetch: vi.fn() };
    const html = renderToStaticMarkup(<ProfilePage />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('个人资料读取失败');
    expect(html).toContain('重试');
    expect(html).not.toContain('profile-header');
    expect(html).not.toContain('免费');
    expect(html).not.toContain(':用户:');
  });

  it('fails closed on every tab, not just the profile tab', () => {
    state.params = new URLSearchParams('tab=security');
    state.profile = { data: undefined, isLoading: false, error: { message: 'boom' }, isFetching: false, refetch: vi.fn() };
    const html = renderToStaticMarkup(<ProfilePage />);
    expect(html).toContain('个人资料读取失败');
    expect(html).not.toContain('security-card');
  });

  it('renders real profile data when the read succeeds', () => {
    const html = renderToStaticMarkup(<ProfilePage />);
    expect(html).toContain('profile-header:小王:pro');
    expect(html).not.toContain('role="alert"');
  });

  it('selects the tab from the address so header links switch tabs', () => {
    state.params = new URLSearchParams('tab=security');
    const html = renderToStaticMarkup(<ProfilePage />);
    expect(html).toContain('data-active-tab="security"');
    expect(html).toContain('security-card');
  });

  it('falls back to the profile tab for unknown tabs', () => {
    state.params = new URLSearchParams('tab=settings');
    expect(renderToStaticMarkup(<ProfilePage />)).toContain('data-active-tab="profile"');
  });

  it('switches tab through Next-synced history so the page follows the address', () => {
    renderToStaticMarkup(<ProfilePage />);
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://x.test/profile?tab=subscription&checkout=success' },
      history: { state: { __NA: true }, replaceState },
    });
    try {
      state.onTabChange?.('security');
    } finally {
      vi.unstubAllGlobals();
    }
    // Passing Next's own state (with __NA) makes its patched replaceState skip the useSearchParams sync.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/profile?tab=security&checkout=success');
  });
});
