/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { Home, LayoutGrid, MessageCircle, UserRound } from 'lucide-react';
import styles from './phone-tabs.module.css';

export type PhoneTab = 'home' | 'chats' | 'tools' | 'me';

/** The four places of the signed-in product on a phone (Owner 2026-11-12, phone plan A: "首页 · 对话 · 功能 · 我的"). */
export const PHONE_TABS = [
  { id: 'home', label: '首页', href: '/app', Icon: Home },
  { id: 'chats', label: '对话', href: '/app/chats', Icon: MessageCircle },
  { id: 'tools', label: '功能', href: '/app/tools', Icon: LayoutGrid },
  { id: 'me', label: '我的', href: '/app/profile', Icon: UserRound },
] as const;

/**
 * The bar at the foot of a phone's screen, the way an app has one (Owner 2026-11-12: "把它当成一个原生的网页 APP 界面来做").
 * It shows under 640px only (phone-tabs.module.css) and stands clear of the home indicator. A page that shows it leaves
 * room for it with `phoneTabsRoom` on the element that scrolls. The conversation pages do not show it: there the message
 * box sits at the foot (WorkspaceFrame leaves it out for the chat and topics areas).
 */
export function PhoneTabs({ on }: { on?: PhoneTab }) {
  return (
    <nav className={styles.tabs} aria-label="主导航" data-phone-tabs="">
      {PHONE_TABS.map(({ id, label, href, Icon }) => (
        <Link key={id} href={href} prefetch={false} aria-current={id === on ? 'page' : undefined}>
          <Icon size={23} strokeWidth={id === on ? 2.2 : 1.8} aria-hidden="true" />{label}
        </Link>
      ))}
    </nav>
  );
}

/** The class that keeps a page's last lines above the bar on a phone. */
export const phoneTabsRoom = styles.room;
