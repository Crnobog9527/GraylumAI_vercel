/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ChatNotice } from '@/components/chat/ChatInlineNotice';
import { startEntryHref, type StartMode } from '@/app/positioning/start-entry';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';

/** The guide card's two entries (POSITIONING-GATE step 3); the same one-click starts as the home page. */
export const POSITIONING_ACTIONS = { mentor: '开始定位', manual: '导入已有定位' } as const;
export const POSITIONING_CARD_LABEL = '需要先完成账号定位';

/** A fresh intent per click: the target page turns it into one start request, so a reload never starts twice. */
export function positioningEntryHref(mode: StartMode, intent: string = crypto.randomUUID()) {
  return startEntryHref(mode, intent);
}

/**
 * The guide card for a user without a confirmed positioning (admission refusal, refused execution, refreshed turn).
 * The text stays the fixed notice string, so the tail and the turn de-duplicate to one card; it says nothing was charged.
 */
export function positioningRequiredNotice(id: string,
  navigate: (href: string) => void = href => window.location.assign(href)): ChatNotice {
  return {
    id, tone: 'warning', label: POSITIONING_CARD_LABEL, text: POSITIONING_REQUIRED_NOTICE,
    actions: (['mentor', 'manual'] as const).map(mode => ({
      label: POSITIONING_ACTIONS[mode], onClick: () => navigate(positioningEntryHref(mode)),
    })),
  };
}
