/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export { noticeConfig, isProductionSite, DEFAULT_NOTICE_FROM, type NoticeConfig, type NoticeConfigResult } from './config';
export { resendTransport, type NoticeTransport, type NoticeTransportResult } from './resend';
export {
  sendPaymentNotice, PaymentNoticeError, MAX_NOTICE_ATTEMPTS, UNKNOWN_RETRY_DELAYS_MS,
  type NoticeResult, type SendNoticeDeps,
} from './sender';
export { enqueuePaymentNotice } from './enqueue';
export {
  noticeDigest, noticeLayout, PAYMENT_NOTICE_KINDS, PAYMENT_NOTICE_LOCALE,
  type PaymentNoticeKind, type PaymentNoticeParams, type PaymentNoticeTemplate, type PaymentNoticeTemplates,
} from './templates';
export { PAYMENT_NOTICE_TEMPLATES } from './registry';
