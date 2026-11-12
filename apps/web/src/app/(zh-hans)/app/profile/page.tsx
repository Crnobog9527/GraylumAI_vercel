'use client';

import { PaymentDisputeNotice } from '@/components/profile/PaymentDisputeNotice';
import { useState, Suspense, useMemo, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, Menu, RefreshCw } from 'lucide-react';
import { logClientDevError } from '@/lib/client-log';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { ProfileShell } from '@/components/profile/ProfileShell';
import GlobalBanner from '@/components/layout/GlobalBanner';
import ProfileSidebar from '@/components/profile/ProfileSidebar';
import {
  UserProfileHeader,
  CreditsAndSubscriptionCards,
  UsageStatsCard,
  QuickActionsCard,
  type MockUser
} from '@/components/profile/PersonalInfoCard';
import { SubscriptionCard, CreditStatsCard } from '@/components/profile/SubscriptionCard';
import BillingRecordsCard from '@/components/profile/BillingRecordsCard';
import { CreditRecordsCard } from '@/components/profile/CreditRecordsCard';
import { SecuritySettingsCard } from '@/components/profile/SecuritySettingsCard';
import { AccountErasureCard } from '@/components/profile/AccountErasureCard';
import { DataUseConsentCard } from '@/components/profile/DataUseConsentCard';
import { FounderProfileCard } from '@/components/founder/FounderProfileCard';
import { DATA_USE_CONSENT_VISIBLE } from '@/components/profile/dataUseConsentVisibility';
import TicketsPanel from '@/components/profile/TicketsPanel';
import { trpc } from '@/trpc/client';
import { useBanner } from '@/hooks/use-banner';
import { useCreditsBalance } from '@/hooks/use-credits';
import { useProfilePrefetch } from '@/hooks/use-profile-prefetch';
import { isProfileTab, withProfileTab, type ProfileTab } from '@/lib/profile-tabs';
import { ProfileLoadError } from '@/components/profile/ProfileLoadError';
import { PaymentNoticeInbox } from '@/components/profile/PaymentNoticeInbox';
import { PageSkeleton } from '@/components/ui/page-skeleton';

function ProfilePageContent() {
  const searchParams = useSearchParams();
  const { banners } = useBanner();

  // 当前分页以地址里的 tab 为准，这样已经在个人中心时点顶部菜单的链接也能切换分页
  const requestedTab = searchParams.get('tab');
  const activeTab: ProfileTab = isProfileTab(requestedTab) ? requestedTab : 'profile';
  const setActiveTab = useCallback((tab: ProfileTab) => {
    // state 传 null：Next 只在非内部调用时同步 useSearchParams，传回它自己的 state 会跳过同步
    window.history.replaceState(null, '', withProfileTab(window.location.href, tab));
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ticketInitialView, setTicketInitialView] = useState<'list' | 'create'>('list');

  // tRPC queries for real data (only enabled after auth check)
  const {
    data: userProfile,
    isLoading: isProfileLoading,
    error: profileError,
    isFetching: isProfileFetching,
    refetch: refetchProfile,
  } = trpc.user.getUserProfile.useQuery();
  const {
    credits,
    status: creditsStatus,
    isLoading: isBalanceLoading,
    error: creditsError,
    refetch: refetchCreditsBalance,
  } = useCreditsBalance();
  // The first tab's cards read four more things once they mount: asked for now, so they are not a second round of waiting.
  useProfilePrefetch(activeTab);
  // The credit summary is read by the cards that show it. It must not hold the whole page: a
  // failing summary would keep the spinner up and remount those cards into another request.
  const isLoading = isProfileLoading || isBalanceLoading;

  // Log errors for debugging
  useEffect(() => {
    if (profileError) {
      logClientDevError('Profile query error');
    }
    if (creditsError) {
      logClientDevError('Credits query error');
    }
  }, [profileError, creditsError]);

  // Map tRPC data to MockUser interface for component compatibility
  const userData: MockUser = useMemo(() => ({
    id: userProfile?.id ?? '',
    email: userProfile?.email ?? '',
    nickname: userProfile?.nickname ?? '用户',
    full_name: userProfile?.full_name ?? userProfile?.nickname ?? '用户',
    avatar_url: userProfile?.avatar_url ?? '',
    credits: creditsStatus === 'ready' && credits !== null ? credits : undefined,
    subscription_tier: (userProfile as any)?.membership_level ?? 'free',
    auth_provider: (userProfile as any)?.auth_provider ?? 'email',
    email_verified: (userProfile as any)?.email_verified ?? false,
    phone_masked: userProfile?.phone_masked ?? '',
    created_date: userProfile?.created_at ?? new Date().toISOString(),
  }), [userProfile, credits, creditsStatus]);

  const [localUser, setLocalUser] = useState<MockUser | null>(null);

  // Sync localUser with userData when data loads
  const effectiveUser = useMemo(() => ({
    ...(localUser ?? userData),
    credits: userData.credits,
  }), [localUser, userData]);

  const handleNavigateToCreateTicket = () => {
    setTicketInitialView('create');
    setActiveTab('tickets');
  };

  const handleNavigateToSecurity = () => {
    setActiveTab('security');
  };

  const handleUserUpdate = (updatedUser: MockUser) => {
    setLocalUser(updatedUser);
  };

  if (isLoading) {
    return (
      <ProfileShell><PageSkeleton rows={6} label="个人中心读取中" /></ProfileShell>
    );
  }

  return (
    <ProfileShell onOpenNav={() => setMenuOpen(true)}>
      {/* 全站横幅公告 */}
      <GlobalBanner banners={banners} />

      <div className="container mx-auto px-4 py-6 md:py-8 max-w-7xl">
        {creditsStatus === 'unavailable' && (
          <div
            className="mb-6 flex flex-col gap-3 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
            }}
          >
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5" style={{ color: 'var(--text-tertiary)' }} />
              <div>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>积分余额暂不可用</div>
                <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  当前无法验证余额，页面不会显示伪零或余额不足提示。
                </div>
              </div>
            </div>
            <Button variant="outline" className="gap-2" onClick={() => void refetchCreditsBalance()}>
              <RefreshCw className="h-4 w-4" />
              重试
            </Button>
          </div>
        )}
        <div className="flex flex-col md:flex-row gap-4 md:gap-8">
          {/* Mobile Sidebar Trigger */}
          <div className="md:hidden mb-4">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2"
                  style={{
                    background: 'var(--bg-secondary)',
                    borderColor: 'var(--border-primary)',
                    color: 'var(--text-secondary)'
                  }}
                >
                  <Menu className="h-4 w-4" />
                  菜单
                </Button>
              </SheetTrigger>
              <SheetContent
                tone="light"
                side="left"
                className="w-[88vw] max-w-80 p-0 pt-6"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
              >
                <SheetTitle className="sr-only">个人中心菜单</SheetTitle>
                <SheetDescription className="sr-only">选择要查看的个人中心栏目</SheetDescription>
                <ProfileSidebar
                  mobile
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                />
              </SheetContent>
            </Sheet>
          </div>

          {/* Desktop Sidebar */}
          <ProfileSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {!userProfile && (
              <ProfileLoadError
                hasError={Boolean(profileError)}
                isRetrying={isProfileFetching}
                onRetry={() => void refetchProfile()}
              />
            )}

            {userProfile && activeTab === 'profile' && (
              <>
                <UserProfileHeader user={effectiveUser} onUserUpdate={handleUserUpdate} />
                <PaymentNoticeInbox />
                <FounderProfileCard />
                <CreditsAndSubscriptionCards
                  user={effectiveUser}
                  onNavigateToSubscription={() => setActiveTab('subscription')}
                />
                <UsageStatsCard user={effectiveUser} />
                <QuickActionsCard
                  onNavigateToTickets={handleNavigateToCreateTicket}
                  onNavigateToSecurity={handleNavigateToSecurity}
                />
              </>
            )}

            {userProfile && activeTab === 'subscription' && (
              <>
                <PaymentDisputeNotice />
                <PaymentNoticeInbox />
                <SubscriptionCard user={effectiveUser} />
                <BillingRecordsCard />
                <CreditStatsCard user={effectiveUser} />
              </>
            )}

            {userProfile && activeTab === 'credits' && <CreditRecordsCard user={effectiveUser} />}

            {userProfile && activeTab === 'security' && <SecuritySettingsCard user={effectiveUser} />}
            {userProfile && activeTab === 'security' && DATA_USE_CONSENT_VISIBLE && <DataUseConsentCard />}
            {/* No "Cookie 和统计设置" card here (Owner 2026-11-12). The statistics choice is still changed from "Cookie 设置" in the
                footer of the public pages (ConsentPreferenceLinks), which stays: withdrawing consent needs a place. */}
            {userProfile && activeTab === 'security' && <AccountErasureCard user={effectiveUser} />}

            {userProfile && activeTab === 'tickets' && (
              // No key here. It used to be keyed on the view the panel reports, so opening a ticket ('detail') remounted
              // the panel, which dropped the chosen ticket and showed the list again. The panel is only mounted on this
              // tab, so `initialView` (where to open it next time: the list, or the form after 联系客服) is all it needs.
              <TicketsPanel
                user={effectiveUser}
                initialView={ticketInitialView}
                onViewChange={(view) => setTicketInitialView(view === 'create' ? 'create' : 'list')}
              />
            )}
          </div>
        </div>
      </div>
    </ProfileShell>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={
      <ProfileShell><PageSkeleton rows={6} label="个人中心读取中" /></ProfileShell>
    }>
      <ProfilePageContent />
    </Suspense>
  );
}
