'use client';

import { memo } from 'react';
import { LogOut } from 'lucide-react';
import { FounderBadge } from '@/components/founder/FounderBadge';
import type { ProfileTab } from '@/lib/profile-tabs';
import { PROFILE_MENU_ITEMS as menuItems, useProfileLogout } from './profile-menu';

export type { ProfileTab };

interface ProfileSidebarProps {
  activeTab: ProfileTab;
  onTabChange: (tab: ProfileTab) => void;
  mobile?: boolean;
}

const ProfileSidebar = memo(function ProfileSidebar({
  activeTab,
  onTabChange,
  mobile = false,
}: ProfileSidebarProps) {
  const { pending: isLoggingOut, run: handleLogout } = useProfileLogout();

  return (
    <div
      className={mobile ? "w-full rounded-none p-4" : "w-56 shrink-0 hidden md:block p-4 h-fit"}
      style={mobile ? undefined : {
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 12,
      }}
    >
      <div className="mb-6">
        <h2
          className="text-base font-bold px-2 mb-4"
          style={{ color: 'var(--text-primary)' }}
        >
          个人中心
        </h2>
        <div className="mb-3 px-2 empty:hidden"><FounderBadge /></div>
        <nav className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-[background-color,border-color,color] duration-200 motion-reduce:transition-none hover:bg-[var(--gl-surface-warm,#faf9f5)] hover:text-[var(--text-primary)]"
                style={{
                  background: isActive ? 'var(--gl-accent-selected, #faf4e5)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: '1px solid transparent'
                }}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="pt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
        <button
          onClick={handleLogout}
          disabled={isLoggingOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors duration-200 motion-reduce:transition-none disabled:opacity-50 hover:text-[var(--error)]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <LogOut className="h-4 w-4" />
          {isLoggingOut ? '退出中...' : '退出登录'}
        </button>
      </div>
    </div>
  );
});

export default ProfileSidebar;
