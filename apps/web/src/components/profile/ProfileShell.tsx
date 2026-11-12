'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { GlobalHeader } from '@/components/opc/rail-view';
import { LanguageSwitch } from '@/components/layout/LanguageSwitch';
import light from '@/components/design/light-tokens.module.css';
import backdrop from './profile-backdrop.module.css';

/**
 * Light page shell of the profile center (DESIGN.md "Profile center"): the workbench's global top bar (logo, 首页 /
 * 对话 / 个人中心, which also stays in the bar on a phone) on the light canvas. `onOpenNav` is the phone menu button
 * of the bar; the profile page uses it to open its own section menu.
 */
export function ProfileShell({ children, onOpenNav }: { children: ReactNode; onOpenNav?: () => void }) {
  return (
    <div className={`${light.light} ${backdrop.shell} min-h-screen`} data-profile-shell>
      {/* Decoration only: the drifting pools of light behind the cards (profile-backdrop.module.css). */}
      <div className={backdrop.backdrop} aria-hidden="true" />
      <GlobalHeader area="library" onOpenNav={onOpenNav} end={<LanguageSwitch />} />
      <div className={backdrop.content}>{children}</div>
    </div>
  );
}
