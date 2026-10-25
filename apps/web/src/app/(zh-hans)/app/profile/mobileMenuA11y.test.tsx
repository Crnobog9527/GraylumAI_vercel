/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  // Force the mobile menu open and render it inline so a static render can inspect it.
  return {
    ...actual,
    Root: (props: React.ComponentProps<typeof actual.Root>) => <actual.Root {...props} open />,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  profile: {} as Record<string, unknown>,
  onTabChange: undefined as undefined | ((tab: string) => void),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => state.params }));
vi.mock('@/trpc/client', () => ({
  trpc: {
    user: { getUserProfile: { useQuery: () => state.profile } },
    // A summary that never finishes: the page must not wait for it (the cards that show it handle it).
    credits: { getCreditsSummary: { useQuery: () => ({ data: undefined, isLoading: true, isError: false }) } },
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
vi.mock('@/components/founder/FounderProfileCard', () => ({ FounderProfileCard: () => null }));
vi.mock('@/components/profile/ReplyLanguageCard', () => ({ ReplyLanguageCard: () => null }));
vi.mock('@/components/profile/SubscriptionCard', () => ({ SubscriptionCard: () => <p>subscription-card</p>, CreditStatsCard: () => null }));
vi.mock('@/components/profile/BillingRecordsCard', () => ({ default: () => null }));
vi.mock('@/components/profile/CreditRecordsCard', () => ({ CreditRecordsCard: () => null }));
vi.mock('@/components/profile/SecuritySettingsCard', () => ({ SecuritySettingsCard: () => <p>security-card</p> }));
vi.mock('@/components/profile/AccountErasureCard', () => ({ AccountErasureCard: () => <p>account-erasure-card</p> }));
vi.mock('@/components/profile/DataUseConsentCard', () => ({ DataUseConsentCard: () => <p>data-use-consent-card</p> }));
const consent = vi.hoisted(() => ({ visible: false }));
vi.mock('@/components/profile/dataUseConsentVisibility', () => ({ get DATA_USE_CONSENT_VISIBLE() { return consent.visible; } }));
vi.mock('@/components/profile/TicketsPanel', () => ({ default: () => null }));

import ProfilePage from './page';

describe('profile mobile menu accessibility', () => {
  it('gives the opened menu dialog an accessible name and description', () => {
    state.params = new URLSearchParams();
    state.profile = {
      data: { id: 'u1', email: 'a@example.com', nickname: '小王', membership_level: 'pro', created_at: '2026-01-01' },
      isLoading: false, error: null, isFetching: false, refetch: vi.fn(),
    };
    const html = renderToStaticMarkup(<ProfilePage />);
    const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/)?.[0] ?? '';
    const labelledBy = dialog.match(/aria-labelledby="([^"]+)"/)?.[1];
    const describedBy = dialog.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${labelledBy}"[^>]*>个人中心菜单<`));
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*>[^<]+<`));
  });
});
