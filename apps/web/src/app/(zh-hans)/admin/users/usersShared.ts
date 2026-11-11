/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Types and labels shared by the admin 用户管理 page, its hook and its views. Moved from page.tsx as is.
import { User, Shield, Crown, Ban, CheckCircle, XCircle } from 'lucide-react';

export type UserStatus = 'active' | 'disabled' | 'banned';
export type MembershipLevel = 'free' | 'pro' | 'gold';
export type UserRole = 'user' | 'admin';

interface User {
  id: string;
  email: string | null; phone?: string | null;
  nickname: string | null;
  avatar_url: string | null;
  role: UserRole;
  status: UserStatus;
  membership_level: MembershipLevel;
  credits: number;
  last_login_at: string | null;
  last_ip: string | null;
  login_record_status?: 'unrecorded';
  created_at: string;
}

export interface ActivityLog {
  id: string;
  action: string;
  action_type: string;
  details: Record<string, unknown>;
  created_at: string;
  admin?: {
    id: string;
    email: string;
    nickname: string | null;
    avatar_url: string | null;
  };
}

export const statusConfig: Record<UserStatus, { label: string; color: string; icon: React.ElementType }> = {
  active: { label: '正常', color: 'bg-emerald-500/20 text-emerald-400', icon: CheckCircle },
  disabled: { label: '禁用', color: 'bg-amber-500/20 text-amber-400', icon: XCircle },
  banned: { label: '封禁', color: 'bg-rose-500/20 text-rose-400', icon: Ban },
};

export const membershipConfig: Record<MembershipLevel, { label: string; color: string; icon: React.ElementType }> = {
  free: { label: '免费版', color: 'bg-slate-500/20 text-slate-400', icon: User },
  pro: { label: 'Pro 专业版', color: 'bg-blue-500/20 text-blue-400', icon: Shield },
  gold: { label: 'Gold 黄金版', color: 'bg-amber-500/20 text-amber-400', icon: Crown },
};

export const PAGE_SIZE_OPTIONS = [10, 20, 50];

// One name, two meanings, as page.tsx had it: the lucide icon (a value) and the row type above. Exported together so
// the moved code that says `<User />` and `(user: User)` reads the same.
export { User };
