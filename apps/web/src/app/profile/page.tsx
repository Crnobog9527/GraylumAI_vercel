'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Menu, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from '@/components/ui/sheet';
import { AppHeader } from '@/components/layout/AppHeader';
import ProfileSidebar, { ProfileTab } from '@/components/profile/ProfileSidebar';
import {
  UserProfileHeader,
  CreditsAndSubscriptionCards,
  UsageStatsCard,
  QuickActionsCard,
  type MockUser
} from '@/components/profile/PersonalInfoCard';
import { SubscriptionCard, CreditStatsCard } from '@/components/profile/SubscriptionCard';
import { CreditRecordsCard } from '@/components/profile/CreditRecordsCard';
import { UsageHistoryCard } from '@/components/profile/UsageHistoryCard';
import { SecuritySettingsCard } from '@/components/profile/SecuritySettingsCard';
import TicketsPanel from '@/components/profile/TicketsPanel';

// Mock user data
const mockUser: MockUser = {
  id: '1',
  email: 'user@example.com',
  nickname: '测试用户',
  full_name: '测试用户',
  avatar_url: '',
  credits: 784,
  total_credits_used: 1256,
  total_credits_purchased: 2000,
  subscription_tier: 'free',
  email_verified: true,
  created_date: '2024-06-15T08:00:00Z'
};

function ProfilePageContent() {
  const searchParams = useSearchParams();

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
  const [localUser, setLocalUser] = useState(mockUser);
  const [isLoading] = useState(false);

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

  const handleLogout = async () => {
    // TODO: Implement logout via tRPC
    console.log('Logout');
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
          className="absolute -top-32 left-1/3 w-[500px] h-[300px] rounded-full opacity-40 blur-[80px]"
          style={{
            background: 'var(--color-primary)',
            contain: 'layout paint',
          }}
        />
        {/* 左下紫色光晕 - 静态 */}
        <div
          className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full opacity-25 blur-[100px]"
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

      {/* 动画样式 - 精简 */}
      <style>{`
        .card-hover:hover {
          border-color: rgba(255, 215, 0, 0.3) !important;
        }
      `}</style>

      {/* 顶部导航 */}
      <AppHeader />

      <div className="container mx-auto px-4 py-8 max-w-7xl relative" style={{ zIndex: 1 }}>
        <div className="flex flex-col md:flex-row gap-8">
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
                className="w-72 p-0 pt-6"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
              >
                <ProfileSidebar
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  onLogout={handleLogout}
                />
              </SheetContent>
            </Sheet>
          </div>

          {/* Desktop Sidebar */}
          <ProfileSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onLogout={handleLogout}
          />

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {activeTab === 'profile' && (
              <>
                <UserProfileHeader user={localUser} onUserUpdate={handleUserUpdate} />
                <CreditsAndSubscriptionCards
                  user={localUser}
                  onNavigateToSubscription={() => setActiveTab('subscription')}
                />
                <UsageStatsCard user={localUser} />
                <QuickActionsCard
                  user={localUser}
                  onNavigateToTickets={handleNavigateToCreateTicket}
                  onNavigateToSecurity={handleNavigateToSecurity}
                />
              </>
            )}

            {activeTab === 'subscription' && (
              <>
                <SubscriptionCard user={localUser} />
                <CreditStatsCard user={localUser} />
              </>
            )}

            {activeTab === 'credits' && <CreditRecordsCard user={localUser} />}

            {activeTab === 'history' && <UsageHistoryCard user={localUser} />}

            {activeTab === 'security' && <SecuritySettingsCard user={localUser} />}

            {activeTab === 'tickets' && (
              <TicketsPanel
                user={localUser}
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
