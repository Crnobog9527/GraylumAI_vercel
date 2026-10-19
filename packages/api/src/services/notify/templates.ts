/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';

/**
 * PAY-NOTIFY payment notices. The kinds must match the CHECK on public.payment_notices. Templates
 * are registered per kind by PR-N2 (scans) and CHARGEBACK; PR-N1 only ships the sending machinery.
 * card_renewal_upcoming is retained for existing records and administrator resend; cron no longer
 * creates or dispatches it because Stripe/Link owns card renewal reminders.
 */
export const PAYMENT_NOTICE_KINDS = [
  'card_renewal_upcoming', 'wallet_founder_expiry', 'wallet_plan_expiry',
  'restore_pro_expiry', 'dispute_won_resubscribe', 'founder_ended',
] as const;
export type PaymentNoticeKind = typeof PAYMENT_NOTICE_KINDS[number];
/** Enqueue-capable kinds exclude the legacy card type; persisted history and resend still accept it. */
export type PaymentNoticeEnqueueKind = Exclude<PaymentNoticeKind, 'card_renewal_upcoming'>;

/** Kinds that the daily scanner may enqueue; card renewal remains a persisted legacy kind. */
export const PAYMENT_NOTICE_CRON_KINDS = [
  'wallet_founder_expiry', 'wallet_plan_expiry', 'restore_pro_expiry', 'founder_ended',
] as const satisfies readonly PaymentNoticeKind[];
export type PaymentNoticeCronKind = typeof PAYMENT_NOTICE_CRON_KINDS[number];

/** N4 (Owner 2026-10-13): one language until the interface has more; mails are Chinese + English. */
export const PAYMENT_NOTICE_LOCALE = 'zh-CN+en';

/** Non-personal values a template needs (dates, amounts, plan ids). Never an address or free text. */
export type PaymentNoticeParams = Record<string, string | number | boolean | null>;

export interface RenderedNotice {
  subject: string;
  text: string;
  html: string;
}

export interface PaymentNoticeTemplate {
  /** Changing the wording means a new version: a retry must send exactly what the first attempt sent. */
  version: string;
  render(params: PaymentNoticeParams): RenderedNotice;
}

export type PaymentNoticeTemplates = Partial<Record<PaymentNoticeKind, PaymentNoticeTemplate>>;

const FOOTER_TEXT = '这是关于你的订单的通知。\nThis is a notice about your order.';
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/**
 * The shared layout: plain paragraphs and the transactional footer. No tracking, no images, no
 * unsubscribe link (transactional only, PAY-NOTIFY §4.3). Paragraphs are escaped here.
 */
export function noticeLayout(subject: string, paragraphs: string[]): RenderedNotice {
  const body = paragraphs.map(p => p.trim()).filter(Boolean);
  const text = [...body, '', FOOTER_TEXT].join('\n\n');
  const html = [...body.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`),
    `<p style="color:#666;font-size:12px">${escapeHtml(FOOTER_TEXT).replace(/\n/g, '<br>')}</p>`].join('\n');
  return { subject, text, html };
}

/**
 * Fixes one mail: recipient, language, template version and the rendered content. Only this digest
 * is stored; a retry with a different digest must not reuse the old idempotency key.
 */
export function noticeDigest(input: { to: string; locale: string; version: string; rendered: RenderedNotice }) {
  const canonical = JSON.stringify([input.to.trim().toLowerCase(), input.locale, input.version,
    input.rendered.subject, input.rendered.text, input.rendered.html]);
  return createHash('sha256').update(canonical).digest('hex');
}
