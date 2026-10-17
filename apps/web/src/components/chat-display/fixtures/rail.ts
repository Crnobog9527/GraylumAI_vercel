/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { UnassignedDraft } from '@/components/opc/draft-row';
import type { RailArea } from '@/components/opc/rail-view';
import type { useConversationRename } from '@/hooks/use-conversation-rename';

/**
 * Sample data for the left rail (`@/components/opc/rail-view`, `conversation-row`, `draft-row`), shared by the
 * landing page and the component tests. One platform with a confirmed account (one pinned and one ordinary
 * conversation), one account whose positioning is still in progress, plus a free conversation and an
 * unassigned draft. Made-up example content only.
 */

export const SAMPLE_RAIL_AREA: RailArea = 'chat';
/** The environment note in the announcement bar; leave it out on the landing page. */
export const SAMPLE_ANNOUNCEMENT_NOTICE = undefined;

export type SampleRailThread = { sessionId: string; name: string; pinned?: boolean; dateLabel: string };
export type SampleRailAccount = {
  projectId: string; name: string;
  /** Absent: shows "定位策略待建立". */
  strategy?: { draftId: string; confirmed: boolean; statusLabel?: string };
  threads: SampleRailThread[];
};

export const SAMPLE_RAIL_PLATFORMS: { platform: string; accounts: SampleRailAccount[] }[] = [
  { platform: '小红书', accounts: [
    { projectId: 'sample-account-1', name: '烘焙小店', strategy: { draftId: 'sample-draft-1', confirmed: true, statusLabel: '当前 v2' },
      threads: [
        { sessionId: 'sample-session-1', name: '三分钟学会做司康', pinned: true, dateLabel: '2026/10/16' },
        { sessionId: 'sample-session-2', name: '周末市集的开场口播', dateLabel: '2026/10/14' },
      ] },
    { projectId: 'sample-account-2', name: '手作蛋糕日记', strategy: { draftId: 'sample-draft-2', confirmed: false }, threads: [] },
  ] },
  { platform: '抖音', accounts: [
    { projectId: 'sample-account-3', name: '小林下班做饭', threads: [] },
  ] },
];
/** The account that is shown with its name being edited. */
export const SAMPLE_RAIL_RENAMING_ACCOUNT = 'sample-account-2';

export const SAMPLE_RAIL_CONVERSATION = { sessionId: 'sample-conversation-1', title: '想做一个美食账号，从哪开始？', lastActivityAt: '2026-10-15T08:00:00Z' };
export const SAMPLE_RAIL_UNASSIGNED_DRAFT: UnassignedDraft = { draftId: 'sample-draft-3', sessionId: 'sample-session-3', businessName: '新店', state: 'draft' };

/** What `ConversationRow` reads from `useConversationRename()`, without the hook: nobody is renaming. */
export const SAMPLE_RAIL_RENAME: ReturnType<typeof useConversationRename> = {
  editingId: '', value: '', setValue: () => undefined, error: '', start: () => undefined, cancel: () => undefined,
  save: async () => undefined, titleOf: (_id: string, title: string) => title,
} as unknown as ReturnType<typeof useConversationRename>;

export const SAMPLE_RAIL_BOTTOM = { creditsLabel: 1200, avatar: '小', name: '小林', membership: '专业会员' };
