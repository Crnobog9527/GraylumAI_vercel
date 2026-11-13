/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { Crown, Headphones, Shield, User, Wallet } from 'lucide-react';
import { logClientDevError } from '@/lib/client-log';
import { createClient } from '@/lib/supabase';
import { buildAppHref } from '@/lib/site-config';
import type { ProfileTab } from '@/lib/profile-tabs';

/** The profile center's sections, in menu order: the section menu (ProfileSidebar.tsx) and the phone's list (ProfileMobileHub.tsx). */
export const PROFILE_MENU_ITEMS: { id: ProfileTab; label: string; icon: typeof User }[] = [
  { id: 'profile', label: '个人资料', icon: User },
  { id: 'subscription', label: '订阅管理', icon: Crown },
  { id: 'credits', label: '积分记录', icon: Wallet },
  { id: 'security', label: '账户安全', icon: Shield },
  { id: 'tickets', label: '工单记录', icon: Headphones },
];

/** Signing out, the same from the section menu and from the phone's list. */
export function useProfileLogout(): { pending: boolean; run: () => Promise<void> } {
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();

      // 根据环境跳转到不同的着陆页
      window.location.href = buildAppHref('/');
    } catch {
      logClientDevError('Logout failed');
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}
