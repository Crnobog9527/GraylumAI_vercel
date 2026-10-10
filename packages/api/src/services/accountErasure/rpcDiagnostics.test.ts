/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { erasureRpcDiagnostic } from './rpcDiagnostics';

describe('durable erasure RPC diagnostics', () => {
  it('identifies the safeupdate SQLSTATE and exact failing RPC without its SQL body', () => {
    expect(erasureRpcDiagnostic('account_erasure_scrub_content', {
      code: '21000', message: 'DELETE requires a WHERE clause', details: 'PRIVATE', hint: 'SECRET',
    })).toBe('ERASURE_RPC_SCRUB_CONTENT_21000');
  });
  it.each(['PRIVATE', 'SECRET_KEY', 'XXXXX', 'toString', '__proto__', '21000 PRIVATE'])('rejects arbitrary code %s', code => {
    expect(erasureRpcDiagnostic('account_erasure_work_batch', { code })).toBe('ERASURE_RPC_WORK_BATCH_DATABASE_ERROR');
  });
  it('does not persist arbitrary operation names or thrown transport details', () => {
    expect(erasureRpcDiagnostic('PRIVATE', { code: '42501' })).toBe('ERASURE_RPC_OTHER_42501');
    expect(erasureRpcDiagnostic('__proto__', null)).toBe('ERASURE_RPC_OTHER_DATABASE_ERROR');
    expect(erasureRpcDiagnostic('bill2_cancel', new Error('SECRET'), 'transport')).toBe('ERASURE_RPC_BILL2_CANCEL_TRANSPORT_UNKNOWN');
    expect(erasureRpcDiagnostic('account_erasure_auth_begin', null, 'timeout')).toBe('ERASURE_RPC_AUTH_BEGIN_TIMEOUT_UNKNOWN');
  });
});
