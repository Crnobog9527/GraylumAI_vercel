'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { Ellipsis } from 'lucide-react';
import type { useConversationRename } from '@/hooks/use-conversation-rename';
import styles from './workspace-frame.module.css';

type Conversation = { sessionId: string; title: string; lastActivityAt: string };

/** One ordinary conversation in the sidebar: link or inline rename, and its "⋯" menu (rename, delete). */
export function ConversationRow({ conversation, menuOpen, menuPosition, onOpenMenu, onCloseMenu, onDelete, rename }: {
  conversation: Conversation;
  menuOpen: boolean;
  menuPosition: CSSProperties;
  onOpenMenu: (event: { currentTarget: HTMLElement }) => void;
  onCloseMenu: () => void;
  onDelete: () => void;
  rename: ReturnType<typeof useConversationRename>;
}) {
  const editing = rename.editingId === conversation.sessionId;
  return <div className={styles.threadRow}>
    {editing ? <div className={styles.renameThread}>
      <input className={styles.inlineRename} autoFocus aria-label="重命名对话" maxLength={80} value={rename.value}
        onChange={(event) => rename.setValue(event.target.value)}
        onBlur={() => void rename.save(conversation.sessionId, conversation.title)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); rename.cancel(); }
          if (event.key === 'Enter') event.currentTarget.blur();
        }}/>
    </div> : <Link className={styles.thread} href={'/runtime?session=' + conversation.sessionId}>
      <span>{conversation.title}</span>
      <small>{new Date(conversation.lastActivityAt).toLocaleDateString('zh-CN')} · 对话</small>
    </Link>}
    {!editing && <button type="button" className={styles.more} aria-label={conversation.title + '的更多操作'}
      aria-expanded={menuOpen} onClick={onOpenMenu}><Ellipsis size={17}/></button>}
    {menuOpen && <div className={styles.workMenu} style={menuPosition} role="menu">
      <button role="menuitem" onClick={() => { onCloseMenu(); rename.start(conversation.sessionId, conversation.title); }}>
        重命名</button>
      <button role="menuitem" className={styles.danger} onClick={() => { onCloseMenu(); onDelete(); }}>删除对话</button>
    </div>}
  </div>;
}
