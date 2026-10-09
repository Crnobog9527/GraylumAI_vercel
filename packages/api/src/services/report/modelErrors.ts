/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Public, bounded error vocabulary; never expose database or provider diagnostics. */
export function reportModelErrorCode(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  if (['REPORT_MODEL_UNAVAILABLE', 'REPORT_MODEL_PRICING_UNAVAILABLE', 'REPORT_MODEL_ADMISSION_REQUIRED',
    'REPORT_MODEL_CONFIG_UNAVAILABLE', 'REPORT_MODEL_CONFLICT', 'REPORT_MODULE_NOT_FOUND'].includes(message)) return message;
  if (message.startsWith('RUNTIME_PRICE_')) return 'REPORT_MODEL_PRICING_UNAVAILABLE';
  if (['RUNTIME_STAGING_MODEL_DENIED', 'RUNTIME_MODEL_CAPABILITY_UNVERIFIED',
    'RUNTIME_MODEL_CAPACITY'].includes(message)) return 'REPORT_MODEL_UNAVAILABLE';
  if (['RUNTIME_STAGING_MODEL_NOT_APPROVED', 'RUNTIME_SKILL_MODEL_DENIED', 'REPORT_PAYG_REQUIRED',
    'BILL2_PAYG_QUOTE_INVALID', 'BILL2_INPUT_PROFILE_INVALID', 'BILL2_START_THRESHOLD_UNCONFIGURED'].includes(message)
    || message.startsWith('RUNTIME_PAYG_') || message.startsWith('RUNTIME_REASONING_')
    || message.startsWith('RUNTIME_BILLING_UNIT_')) return 'REPORT_MODEL_ADMISSION_REQUIRED';
  return undefined;
}
