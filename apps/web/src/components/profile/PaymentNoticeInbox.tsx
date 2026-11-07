/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { trpc } from '@/trpc/client';

/**
 * PHONE-OTP: membership reminders (founder / wallet plan expiry, restored Pro expiry, founder ended) that could not be
 * mailed because the account has no email address. Shown on the account page instead; nothing when there are none.
 */
export function PaymentNoticeInbox() {
  const inbox = trpc.user.paymentNoticeInbox.useQuery(undefined, { staleTime: 60_000 });
  if (!inbox.data?.length) return null;
  return (
    <section role="status" aria-label="会员提醒" className="mb-4 space-y-3 rounded-xl border p-4"
      style={{ borderColor: 'var(--color-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
      {inbox.data.map(notice => (
        <div key={notice.id} className="space-y-1">
          <div className="font-medium">{notice.title}</div>
          {notice.lines.map(line => <p key={line} className="text-sm" style={{ color: 'var(--text-secondary)' }}>{line}</p>)}
        </div>
      ))}
    </section>
  );
}
