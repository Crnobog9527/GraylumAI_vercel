/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PaymentNoticeTemplates } from './templates';

/**
 * Templates per kind. Empty in PR-N1: PR-N2 adds the reminder templates (wording approved by the
 * Owner, N4) and CHARGEBACK the dispute one. A notice without a template is kept pending, never sent.
 */
export const PAYMENT_NOTICE_TEMPLATES: PaymentNoticeTemplates = {};
