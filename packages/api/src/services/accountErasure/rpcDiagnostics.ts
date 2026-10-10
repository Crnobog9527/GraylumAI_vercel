/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Only fixed operation labels and known protocol codes reach the durable request.
// Never persist message, details, hint, SQL text, arguments, or a thrown error's body.
const operations: Readonly<Record<string, string>> = {
  account_erasure_work_batch: 'WORK_BATCH',
  account_erasure_scrub_content: 'SCRUB_CONTENT',
  account_erasure_scrub_runtime: 'SCRUB_RUNTIME',
  account_erasure_scrub_receipts: 'SCRUB_RECEIPTS',
  account_erasure_scrub_run: 'SCRUB_RUN',
  account_erasure_scrub_calls: 'SCRUB_CALLS',
  account_erasure_scrub_ledger: 'SCRUB_LEDGER',
  account_erasure_scrub_payment: 'SCRUB_PAYMENT',
  account_erasure_detach_runtime: 'DETACH_RUNTIME',
  account_erasure_storage_ready: 'STORAGE_READY',
  account_erasure_local_cleanup: 'LOCAL_CLEANUP',
  account_erasure_auth_begin: 'AUTH_BEGIN',
  account_erasure_auth_result: 'AUTH_RESULT',
  bill2_cancel: 'BILL2_CANCEL', bill2_finalize: 'BILL2_FINALIZE', bill2_read: 'BILL2_READ',
  runtime_financial_recovery: 'FINANCIAL_RECOVERY',
};
const databaseCodes = new Set([
  '21000', '22001', '22003', '22007', '22023', '22P02', '23502', '23503', '23505', '23514',
  '25000', '25006', '25P02', '40001', '40P01', '42501', '42601', '42702', '42703', '42804',
  '42883', '42P01', '42P17', '53100', '53200', '53300', '54001', '55P03', '57014', '57P01',
  'P0001', 'XX000', 'PGRST002', 'PGRST116', 'PGRST202', 'PGRST203', 'PGRST301',
]);
export function erasureRpcDiagnostic(name: string, error: unknown, outcome: 'error' | 'transport' | 'timeout' = 'error'): string {
  const operation = Object.hasOwn(operations, name) ? operations[name] : 'OTHER';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const category = outcome === 'transport' ? 'TRANSPORT_UNKNOWN' : outcome === 'timeout' ? 'TIMEOUT_UNKNOWN'
    : typeof code === 'string' && databaseCodes.has(code) ? code : 'DATABASE_ERROR';
  return `ERASURE_RPC_${operation}_${category}`;
}
