/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import styles from './chat-inline-notice.module.css';

/**
 * One look for every conversation notice (status, retry, gate stop, failure) on the chat
 * surfaces. Notices sit in the message flow under the turn they belong to, like ChatGPT and
 * Claude.ai, never above or below the composer. Presentation only: actions call the page's
 * existing handlers unchanged.
 */
export type ChatNoticeTone = 'status' | 'warning' | 'error' | 'success';
export type ChatNoticeAction = { label: string; onClick: () => void; disabled?: boolean };
export type ChatNotice = {
  id: string;
  tone: ChatNoticeTone;
  text: ReactNode;
  actions?: ChatNoticeAction[];
  /** Shows a small spinner: the work is still running. */
  busy?: boolean;
  /** Accessible name, for notices tests and assistive tech look up by role. */
  label?: string;
};

/** The only action names on the chat surfaces. */
export const CHAT_ACTION = { retry: '重试', stop: '停止' } as const;

/** Status under an optimistic user bubble until the server records the turn. */
export function pendingSendLabel(sending: boolean) {
  return sending ? '发送中 · 等待服务器确认' : '尚未确认保存 · 原请求已保留';
}

type NoticeProps = Omit<ChatNotice, 'id' | 'text'> & {
  children: ReactNode;
  className?: string;
  /** A page-level conflict that must interrupt assistive tech even when it is only a warning. */
  alert?: boolean;
};

export function ChatInlineNotice({ tone, children, actions, busy, label, className, alert }: NoticeProps) {
  return (
    <div role={alert || tone === 'error' ? 'alert' : 'status'} aria-label={label} data-chat-notice={tone}
      className={cn(styles.notice, styles[tone], className)}>
      {busy && <Loader2 aria-hidden className={styles.spinner} />}
      <div className={styles.text}>{children}</div>
      {actions?.length ? (
        <span className={styles.actions}>
          {actions.map(action => (
            <button type="button" key={action.label} disabled={action.disabled} onClick={action.onClick}>{action.label}</button>
          ))}
        </span>
      ) : null}
    </div>
  );
}

type MaybeNotice = ChatNotice | null | false | undefined | "";

/** Notices in order, without empty entries; one text is shown once (one event, one message). */
export function uniqueNotices(notices: readonly MaybeNotice[]): ChatNotice[] {
  const seen = new Set<string>();
  const result: ChatNotice[] = [];
  for (const notice of notices) {
    if (!notice || notice.text === '' || notice.text == null) continue;
    const key = typeof notice.text === 'string' ? notice.text : notice.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(notice);
  }
  return result;
}

export function ChatNoticeList({ notices, className }: { notices: readonly MaybeNotice[]; className?: string }) {
  const shown = uniqueNotices(notices);
  if (!shown.length) return null;
  return (
    <div className={cn(styles.list, className)} data-chat-notices="">
      {shown.map(({ id, text, ...notice }) => <ChatInlineNotice key={id} {...notice}>{text}</ChatInlineNotice>)}
    </div>
  );
}

export function ChatPendingStatus({ sending }: { sending: boolean }) {
  return <small role="status" className={styles.pending}>{pendingSendLabel(sending)}</small>;
}
