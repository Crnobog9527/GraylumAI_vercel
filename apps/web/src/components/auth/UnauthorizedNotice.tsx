'use client';

import { LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UnauthorizedNoticeReason } from '@/lib/auth-recovery';

const NOTICE_TEXT: Record<UnauthorizedNoticeReason, string> = {
  'no-session': '登录已失效，请重新登录。',
  'session-rejected': '登录状态异常，请重新登录。',
};

interface UnauthorizedNoticeProps {
  reason: UnauthorizedNoticeReason;
  busy: boolean;
  onRelogin: () => void;
}

// Shown when automatic recovery has been used up; the visitor decides when to go to the login page.
export function UnauthorizedNotice({ reason, busy, onRelogin }: UnauthorizedNoticeProps) {
  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-4 z-[100] mx-auto flex max-w-md flex-col gap-3 rounded-2xl p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
    >
      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{NOTICE_TEXT[reason]}</span>
      <Button className="shrink-0 gap-2" disabled={busy} onClick={onRelogin}>
        <LogIn className="h-4 w-4" />
        重新登录
      </Button>
    </div>
  );
}
