'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { ChevronLeft, ChevronRight, LogOut, MessageSquareText, Shield } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { profileTabHref, type ProfileTab } from '@/lib/profile-tabs';
import { PROFILE_MENU_ITEMS, useProfileLogout } from './profile-menu';
import styles from './profile-mobile.module.css';

export const PROFILE_HUB_TITLE = '我的';
const sectionLabel = (tab: ProfileTab) => PROFILE_MENU_ITEMS.find(item => item.id === tab)?.label ?? '';

/**
 * "我的" on a phone (Owner 2026-11-12, mobile plan A, screen A5): the profile center as one list. On top who is signed in
 * and the credit balance, each with the one thing people come here for; then the five sections as rows. Nothing here is new
 * data or a new destination: every row opens a section the desktop menu already has. Shown only at 639px and below
 * (profile-mobile.module.css); the page renders it while no section is chosen in the address.
 */
export function ProfileMobileHub({ name, initial, avatarUrl, membership, credits, onOpen, onFeedback, isAdmin = false }: {
  name: string; initial: string; avatarUrl?: string | null;
  /** The plan line under the name; empty while it is not known (never a default plan). */
  membership: string;
  /** The balance, or undefined while it cannot be verified: then a dash, never a zero. */
  credits: number | undefined;
  onOpen: (tab: ProfileTab) => void; onFeedback: () => void;
  /** An admin's way into the admin console (Owner 2026-11-13). Only the link: /admin still checks the role on the server. */
  isAdmin?: boolean;
}) {
  const logout = useProfileLogout();
  const open = (tab: ProfileTab) => (event: React.MouseEvent) => { event.preventDefault(); onOpen(tab); };
  return (
    <div className={styles.hub} data-testid="profile-hub">
      <h1 className={styles.title}>{PROFILE_HUB_TITLE}</h1>
      <div className={styles.card}>
        <Avatar className="h-12 w-12 flex-none"><AvatarImage src={avatarUrl ?? undefined} alt="" />
          <AvatarFallback style={{ background: '#f3c63f', color: '#fff', fontSize: 18 }}>{initial}</AvatarFallback></Avatar>
        <div className={styles.who}><b>{name}</b>{membership && <small>{membership}</small>}</div>
        <a className={styles.pill} href={profileTabHref('subscription')} onClick={open('subscription')}>订阅管理</a>
      </div>
      <div className={`${styles.card} ${styles.credits}`}>
        <div className={styles.who}><small>积分余额</small><b>{credits === undefined ? '—' : credits.toLocaleString('en-US')}</b></div>
        <a className={styles.pill} href={profileTabHref('credits')} onClick={open('credits')}>积分记录</a>
      </div>

      <p className={styles.caption}>账户</p>
      <ul className={styles.rows}>
        {PROFILE_MENU_ITEMS.map(({ id, label, icon: Icon }) => <li key={id}>
          {/* 个人资料 is the address without a tab on desktop; here that address is this list, so its row names the tab. */}
          <a className={styles.row} href={id === 'profile' ? '/app/profile?tab=profile' : profileTabHref(id)} onClick={open(id)}>
            <Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span><ChevronRight size={18} aria-hidden="true" /></a>
        </li>)}
      </ul>

      <p className={styles.caption}>其他</p>
      <ul className={styles.rows}>
        <li><button type="button" className={styles.row} onClick={onFeedback}>
          <MessageSquareText size={19} strokeWidth={1.7} aria-hidden="true" /><span>在线反馈</span>
          <ChevronRight size={18} aria-hidden="true" /></button></li>
        {isAdmin && <li><a className={styles.row} href="/admin" data-testid="profile-hub-admin-entry">
          <Shield size={19} strokeWidth={1.7} aria-hidden="true" /><span>管理后台</span>
          <ChevronRight size={18} aria-hidden="true" /></a></li>}
        <li><button type="button" className={`${styles.row} ${styles.quiet}`} disabled={logout.pending} onClick={() => void logout.run()}>
          <LogOut size={19} strokeWidth={1.7} aria-hidden="true" /><span>{logout.pending ? '退出中...' : '退出登录'}</span></button></li>
      </ul>
    </div>
  );
}

/** A section's top row on a phone: back to the list on the left, the section's name in the middle. */
export function ProfileMobileBack({ tab, onBack }: { tab: ProfileTab; onBack: () => void }) {
  return (
    <div className={styles.back}>
      <button type="button" aria-label={`返回${PROFILE_HUB_TITLE}`} onClick={onBack}><ChevronLeft size={24} aria-hidden="true" /></button>
      <h1>{sectionLabel(tab)}</h1>
    </div>
  );
}

export const profileMobileStyles = styles;
