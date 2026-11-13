'use client';

import { PaymentDisputeNotice } from '@/components/profile/PaymentDisputeNotice';
import { useState, Suspense, useMemo, useEffect, useCallback, useRef } from 'react';
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
import { ProfileMobileBack, ProfileMobileHub, profileMobileStyles } from '@/components/profile/ProfileMobileHub';
import { accountDisplayName, membershipText } from '@/lib/account-presentation';
import { PhoneTabs, phoneTabsRoom } from '@/components/opc/phone-tabs';
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
  // On a phone (639px and below) the address without a tab is the "我的" list, and a tab in the address is that section as a
  // page of its own (Owner 2026-11-12, mobile plan A). Which of the two shows is CSS (profile-mobile.module.css), so the first
  // frame is right without knowing the screen; above 639px the list never shows and no tab still means 个人资料.
  const onHub = !isProfileTab(requestedTab);
  const cameFromHub = useRef(false);
  const openFromHub = useCallback((tab: ProfileTab) => {
    // Pushed, not replaced: the phone's own back gesture then returns to the list.
    cameFromHub.current = true;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    window.scrollTo(0, 0);
  }, []);
  const backToHub = useCallback(() => {
    // Opened from the list: step back to it. Opened by a link straight to a section: there is no list behind, so show it in place.
    if (cameFromHub.current) { cameFromHub.current = false; window.history.back(); return; }
    const url = new URL(window.location.href);
    url.searchParams.delete('tab');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    window.scrollTo(0, 0);
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
  // The admin console's link (Owner 2026-11-13): the workbench header that used to carry it is no longer on these pages.
  const isAdmin = userProfile?.role === 'admin';

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
    // A phone's bottom bar (phone plan A): "我的" is this page's list. A section opened from it is a page of its own with a way back,
    // so the bar shows on the list only. It draws nothing above 639px.
    <ProfileShell onOpenNav={() => setMenuOpen(true)} foot={onHub ? <PhoneTabs on="me" /> : null}>
      {/* 全站横幅公告 */}
      <GlobalBanner banners={banners} />

      <div className={`container mx-auto px-4 py-6 md:py-8 max-w-7xl ${onHub ? phoneTabsRoom : ''}`}>
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
          {userProfile && onHub && <ProfileMobileHub
            name={accountDisplayName({ data: userProfile }) ?? '用户'} avatarUrl={effectiveUser.avatar_url}
            initial={effectiveUser.full_name?.[0] || effectiveUser.email?.[0]?.toUpperCase() || 'U'}
            membership={membershipText({ data: userProfile })} credits={effectiveUser.credits}
            onOpen={openFromHub} onFeedback={() => { setTicketInitialView('create'); openFromHub('tickets'); }}
            isAdmin={isAdmin} />}

          {/* The section drawer: between the phone and the desktop widths (640–767px). On a phone the list above replaces it. */}
          <div className={`md:hidden mb-4 ${profileMobileStyles.drawerTrigger}`}>
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
                  isAdmin={isAdmin}
                />
              </SheetContent>
            </Sheet>
          </div>

          {/* Desktop Sidebar */}
          <ProfileSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            isAdmin={isAdmin}
          />

          {/* Main Content */}
          <div className={`flex-1 min-w-0 ${onHub && userProfile ? profileMobileStyles.behindHub : ''}`}>
            {!onHub && <ProfileMobileBack tab={activeTab} onBack={backToHub} />}
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
