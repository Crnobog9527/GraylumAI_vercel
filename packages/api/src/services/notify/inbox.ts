/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { PAYMENT_NOTICE_TEMPLATES } from './registry';
import { PAYMENT_NOTICE_KINDS } from './templates';

/**
 * PHONE-OTP: a phone-only account has no email, so sendPaymentNotice records its reminders as skipped
 * (PAYMENT_NOTICE_NO_RECIPIENT) instead of erroring or retrying. The account page shows those of the last 14 days
 * here, rendered by the same templates as the mail (Chinese part only). Read only; nothing is marked or sent.
 */
const rows = z.array(z.object({
  id: z.string().uuid(),
  kind: z.enum(PAYMENT_NOTICE_KINDS),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.string(),
}));

export type InboxNotice = { id: string; kind: string; title: string; lines: string[]; createdAt: string };

const CJK = /[一-鿿]/;

export async function readPaymentNoticeInbox(admin: Pick<SupabaseClient, 'rpc'>, userId: string): Promise<InboxNotice[]> {
  const { data, error } = await admin.rpc('payment_notice_inbox', { p_user_id: userId });
  if (error) {
    logger.warn('billing', 'payment_notice_inbox_failed', { code: error.code ?? 'unknown' });
    return [];
  }
  const parsed = rows.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.flatMap(row => {
    const template = PAYMENT_NOTICE_TEMPLATES[row.kind];
    if (!template) return [];
    try {
      const rendered = template.render(row.params);
      const lines = rendered.text.split('\n\n').map(line => line.trim()).filter(line => CJK.test(line) && !line.includes('\n')); // the footer is two-line
      return [{ id: row.id, kind: row.kind, title: rendered.subject.split(' / ')[0] ?? rendered.subject,
        lines: lines.slice(0, 3), createdAt: row.createdAt }];
    } catch {
      return [];
    }
  });
}
