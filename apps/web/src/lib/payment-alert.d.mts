/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export function reportPaymentEvidenceConflict(eventType: string): void;
export function reportAnnualReleaseAnomalies(anomalies: Array<{ subscriptionId: string | null; reason: string }>): void;
export function reportStripeCardReconciliation(findings: Array<{ kind: string }>): void;
export function reportPaymentNoticeAttention(results: Array<{ attention?: string | null }>): void;
