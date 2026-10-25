/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DatabaseReadError } from '../../lib/databaseReadError';
import { logger } from '../../lib/logger';

// Exact SQL exception messages only. Never log database detail, hints, payloads,
// actor identifiers or an arbitrary upstream message.
const claimRejections = new Set([
  'OPC_BUSINESS_ARCHIVED',
  'RUNTIME_NEW_CALLS_STOPPED', 'RUNTIME_USER_DAILY_USD_LIMIT',
  'RUNTIME_SITE_DAILY_USD_LIMIT', 'RUNTIME_STOP_LOSS_CONFIG_INVALID',
  'BILL2_START_THRESHOLD_UNCONFIGURED', 'BILL2_PAYG_QUOTE_INVALID',
  'BILL2_PAYG_BOUND_MISMATCH', 'BILL2_NOMINAL_BOUND_MISMATCH',
  'BILL2_NOMINAL_PRICING_INVALID', 'BILL2_PAYG_METERING_BLOCKED',
  'BILL2_CALL_BUDGET_OR_CONTRACT', 'BILL2_CALL_CONFLICT', 'BILL2_CALL_PENDING',
  'BILL2_CALL_TOO_LARGE', 'BILL2_DISPATCH_CLOSED', 'BILL2_RUN_DENIED',
  'BILL2_ACTOR_DENIED', 'BILL2_POLICY_DENIED', 'BILL2_PREDEDUCT_CONFLICT',
  'RUNTIME_RESUME_CONFLICT', 'RUNTIME_CHECKPOINT_CONFLICT', 'RUNTIME_STOP_REQUESTED',
  'RUNTIME_TEST_BUDGET_EXHAUSTED', 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED',
  'REPORT_MEMBERSHIP_REQUIRED', 'REPORT_ENTITLEMENTS_UNAVAILABLE', 'REPORT_SOURCE_CONFLICT',
  'FUSION_GROUP_DENIED', 'FUSION_GROUP_INVALID', 'FUSION_GROUP_CONFLICT',
  // RESEARCH-TOOLS (0255): a tool subcall whose frozen price or quote can no longer be charged.
  'BILL2_TOOL_PRICE_EXPIRED', 'BILL2_TOOL_PRICE_INVALID', 'BILL2_TOOL_QUOTE_INVALID', 'BILL2_CALL_POLICY_DENIED',
]);

export class BillingClaimRejection extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BillingClaimRejection';
  }
}

// DB-PERF: an opaque failure keeps only which RPC failed and a diagnostic class, so a load test can tell a
// deadlock (40P01), a statement timeout (57014), a PostgREST pool wait (PGRST003) and the client's own abort apart.
function opaqueDiagnostics(error: unknown, rpc?: string) {
  const fields = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const databaseCode = new DatabaseReadError('', typeof fields.code === 'string' ? fields.code : undefined).databaseCode;
  const clientTimeout = typeof fields.message === 'string' && /^(?:AbortError|TimeoutError)\b/.test(fields.message);
  return { ...(rpc ? { rpc } : {}), ...(databaseCode ? { databaseCode } : {}), ...(clientTimeout ? { clientTimeout } : {}) };
}

export function claimFailure(error: unknown, rpc?: string): Error {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : null;
  const code = typeof message === 'string' && claimRejections.has(message)
    ? message : 'BILL2_DATABASE_UNAVAILABLE';
  logger.warn('api', 'Billing claim rejected',
    code === 'BILL2_DATABASE_UNAVAILABLE' ? { code, ...opaqueDiagnostics(error, rpc) } : { code });
  return code === 'BILL2_DATABASE_UNAVAILABLE' ? new Error(code) : new BillingClaimRejection(code);
}
