'use client';

import { useState, Suspense, useMemo, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, Loader2, Menu, RefreshCw } from 'lucide-react';
import { logClientDevError } from '@/lib/client-log';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from '@/components/ui/sheet';
import { AppHeader } from '@/components/layout/AppHeader';
import GlobalBanner from '@/components/layout/GlobalBanner';
import ProfileSidebar, { ProfileTab } from '@/components/profile/ProfileSidebar';
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
import { UsageHistoryCard } from '@/components/profile/UsageHistoryCard';
import { SecuritySettingsCard } from '@/components/profile/SecuritySettingsCard';
import TicketsPanel from '@/components/profile/TicketsPanel';
import { trpc } from '@/trpc/client';
import { useBanner } from '@/hooks/use-banner';
import { useCreditsBalance } from '@/hooks/use-credits';

function ProfilePageContent() {
  const searchParams = useSearchParams();
  const { banners } = useBanner();

  // 从 URL 参数读取初始 tab
  const getInitialTab = (): ProfileTab => {
    const tab = searchParams.get('tab');
    if (tab && ['profile', 'subscription', 'credits', 'history', 'security', 'tickets'].includes(tab)) {
      return tab as ProfileTab;
    }
    return 'profile';
  };

  const [activeTab, setActiveTab] = useState<ProfileTab>(getInitialTab);
  const [ticketInitialView, setTicketInitialView] = useState<'list' | 'create'>('list');

  // tRPC queries for real data (only enabled after auth check)
  const { data: userProfile, isLoading: isProfileLoading, error: profileError } = trpc.user.getUserProfile.useQuery();
  const {
    credits,
    status: creditsStatus,
    isLoading: isBalanceLoading,
    error: creditsError,
    refetch: refetchCreditsBalance,
  } = useCreditsBalance();
  const { data: creditsSummary, isLoading: isSummaryLoading } = trpc.credits.getCreditsSummary.useQuery({ period: 'month' });

  const isLoading = isProfileLoading || isBalanceLoading || isSummaryLoading;

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
    total_credits_used: creditsSummary?.totalSpent ?? 0,
    total_credits_purchased: creditsSummary?.totalEarned ?? 0,
    subscription_tier: (userProfile as any)?.membership_level ?? 'free',
    auth_provider: (userProfile as any)?.auth_provider ?? 'email',
    email_verified: (userProfile as any)?.email_verified ?? false,
    created_date: userProfile?.created_at ?? new Date().toISOString(),
  }), [userProfile, credits, creditsStatus, creditsSummary]);

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
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--color-primary)' }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
      {/* 动态背景 */}
      <div className="absolute inset-0 pointer-events-none">
        {/* 顶部金色光晕 - 静态 */}
        <div
          className="absolute -top-16 left-1/3 h-[150px] w-[220px] rounded-full opacity-22 blur-[48px] md:-top-24 md:h-[240px] md:w-[420px] md:opacity-30 md:blur-[68px]"
          style={{
            background: 'var(--color-primary)',
            contain: 'layout paint',
          }}
        />
        {/* 左下紫色光晕 - 静态 */}
        <div
          className="absolute bottom-0 left-0 h-[180px] w-[180px] rounded-full opacity-14 blur-[52px] md:h-[320px] md:w-[320px] md:opacity-18 md:blur-[80px]"
          style={{
            background: 'rgba(139,92,246,0.5)',
            contain: 'layout paint',
          }}
        />
        {/* 网格纹理 */}
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,215,0,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,215,0,0.1) 1px, transparent 1px)',
            backgroundSize: '50px 50px',
            contain: 'layout paint',
          }}
        />
      </div>

      {/* 顶部导航 */}
      <AppHeader />

      {/* 全站横幅公告 */}
      <GlobalBanner banners={banners} />

      <div className="container mx-auto px-4 py-8 max-w-7xl relative" style={{ zIndex: 1 }}>
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
            <Sheet>
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
                side="left"
                className="w-[88vw] max-w-80 p-0 pt-6"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
              >
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
            {activeTab === 'profile' && (
              <>
                <UserProfileHeader user={effectiveUser} onUserUpdate={handleUserUpdate} />
                <CreditsAndSubscriptionCards
                  user={effectiveUser}
                  onNavigateToSubscription={() => setActiveTab('subscription')}
                />
                <UsageStatsCard user={effectiveUser} />
                <QuickActionsCard
                  user={effectiveUser}
                  onNavigateToTickets={handleNavigateToCreateTicket}
                  onNavigateToSecurity={handleNavigateToSecurity}
                  onUserUpdate={handleUserUpdate}
                />
              </>
            )}

            {activeTab === 'subscription' && (
              <>
                <SubscriptionCard user={effectiveUser} />
                <BillingRecordsCard />
                <CreditStatsCard user={effectiveUser} />
              </>
            )}

            {activeTab === 'credits' && <CreditRecordsCard user={effectiveUser} />}

            {activeTab === 'history' && <UsageHistoryCard user={effectiveUser} />}

            {activeTab === 'security' && <SecuritySettingsCard user={effectiveUser} />}

            {activeTab === 'tickets' && (
              <TicketsPanel
                user={effectiveUser}
                key={`${activeTab}-${ticketInitialView}`}
                initialView={ticketInitialView}
                onViewChange={(v) => setTicketInitialView(v as 'list' | 'create')}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--color-primary)' }} />
      </div>
    }>
      <ProfilePageContent />
    </Suspense>
  );
}
