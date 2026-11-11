/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ChatNotice } from '@/components/chat/ChatInlineNotice';
import { startEntryHref, type StartMode } from '@/app/(zh-hans)/app/positioning/start-entry';
import { splitProfiles, type ProfileBusiness } from '@/components/opc/profile-archive/profile-archive';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';

/** The guide card's two entries (POSITIONING-GATE step 3); the same one-click starts as the home page. */
export const POSITIONING_ACTIONS = { mentor: '开始定位', manual: '导入已有定位', resume: '继续我的定位' } as const;
export const POSITIONING_CARD_LABEL = '需要先完成账号定位';

/** A fresh intent per click: the target page turns it into one start request, so a reload never starts twice. */
export function positioningEntryHref(mode: StartMode, intent: string = crypto.randomUUID()) {
  return startEntryHref(mode, intent);
}

/**
 * What the account already has when the guide card shows (走查 26): a positioning under way that the first button should open
 * instead of starting another (a second start is refused once the profile allowance is used: OPC_PROFILE_LIMIT), none, or not
 * known yet. Only a user without a confirmed positioning sees the card, so any profile of theirs that is not archived is one
 * still under way. A failed read counts as none: the two ordinary entries are always valid.
 */
export type ExistingPositioning = { state: 'checking' } | { state: 'none' } | { state: 'draft'; draftId: string };
export function existingPositioning(businesses: readonly ProfileBusiness[] | undefined, failed: boolean): ExistingPositioning {
  if (failed) return { state: 'none' };
  if (!businesses) return { state: 'checking' };
  // The server lists profiles oldest first; the newest one that can still be worked on is the one to go back to.
  const draftId = splitProfiles(businesses, undefined).active.map(row => row.draftId).filter(Boolean).at(-1);
  return draftId ? { state: 'draft', draftId } : { state: 'none' };
}

/**
 * The guide card for a user without a confirmed positioning (admission refusal, refused execution, refreshed turn).
 * The text stays the fixed notice string, so the tail and the turn de-duplicate to one card; it says nothing was charged.
 * The buttons follow `existing`: 继续我的定位 opens the positioning under way; while that is being read the card shows its
 * text alone, so a button never changes under the pointer.
 */
export function positioningRequiredNotice(id: string,
  navigate: (href: string) => void = href => window.location.assign(href),
  existing: ExistingPositioning = { state: 'none' }): ChatNotice {
  const entry = (mode: StartMode) => ({ label: POSITIONING_ACTIONS[mode], onClick: () => navigate(positioningEntryHref(mode)) });
  return {
    id, tone: 'warning', label: POSITIONING_CARD_LABEL, text: POSITIONING_REQUIRED_NOTICE,
    actions: existing.state === 'checking' ? []
      : existing.state === 'draft'
        ? [{ label: POSITIONING_ACTIONS.resume, onClick: () => navigate('/app/positioning/' + existing.draftId) }, entry('manual')]
        : [entry('mentor'), entry('manual')],
  };
}
