'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { Ellipsis } from 'lucide-react';
import styles from './workspace-frame.module.css';

export type UnassignedDraft = {
  draftId: string; sessionId?: string; projectId?: string; businessName?: string; state?: string;
  conversationDeleted?: boolean; topicSessionId?: string | null;
};

/**
 * A positioning draft under "待归类". Its "⋯" menu deletes the conversation (one click, like any
 * conversation). After that the draft stays read-only with its confirmed content (Owner 2026-10-14)
 * and the menu offers deleting the whole draft through the existing work deletion.
 */
export function DraftRow({ draft, review, menuOpen, menuPosition, onOpenMenu, onCloseMenu, onDeleteConversation, onDeleteDraft }: {
  draft: UnassignedDraft;
  /** The newest jury review's mark while it runs or waits for the chapter choices (fusionReview.mine). */
  review?: string | null;
  menuOpen: boolean;
  menuPosition: CSSProperties;
  onOpenMenu: (event: { currentTarget: HTMLElement }) => void;
  onCloseMenu: () => void;
  onDeleteConversation: (sessionId: string, name: string) => void;
  onDeleteDraft: (projectId: string, name: string) => void;
}) {
  const name = (draft.businessName ?? '新账号') + ' · 定位分析';
  const status = (draft.conversationDeleted ? '对话已删除 · 只读' : draft.state === 'published' ? '已确认' : '进行中')
    + (review ? ' · ' + review : '');
  const canDelete = draft.conversationDeleted ? Boolean(draft.projectId) : Boolean(draft.sessionId);
  return <div className={styles.threadRow}>
    <Link prefetch={false} className={styles.thread} href={'/app/positioning/' + draft.draftId}><span>{name}</span><small>{status}</small></Link>
    {canDelete && <button type="button" className={styles.more} aria-label={name + '的更多操作'} aria-expanded={menuOpen}
      onClick={onOpenMenu}><Ellipsis size={17}/></button>}
    {menuOpen && <div className={styles.workMenu} style={menuPosition} role="menu">
      {draft.conversationDeleted
        ? <button role="menuitem" className={styles.danger}
          onClick={() => { onCloseMenu(); onDeleteDraft(draft.projectId!, name); }}>永久删除稿件与成果</button>
        : <button role="menuitem" className={styles.danger}
          onClick={() => { onCloseMenu(); onDeleteConversation(draft.sessionId!, name); }}>删除对话</button>}
    </div>}
  </div>;
}
