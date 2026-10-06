/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { claimFailure, BillingClaimRejection } from '../bill2/claimFailure';
import { billingClaimNotice, withClaimNotice } from './claimNotice';

it.each([
  'BILL2_START_THRESHOLD_UNCONFIGURED', 'BILL2_PAYG_QUOTE_INVALID',
  'BILL2_PAYG_BOUND_MISMATCH', 'BILL2_NOMINAL_BOUND_MISMATCH',
  'BILL2_NOMINAL_PRICING_INVALID', 'BILL2_PAYG_METERING_BLOCKED',
  'BILL2_CALL_BUDGET_OR_CONTRACT', 'BILL2_CALL_CONFLICT', 'BILL2_CALL_PENDING',
  'BILL2_CALL_TOO_LARGE', 'BILL2_DISPATCH_CLOSED', 'BILL2_RUN_DENIED',
  'BILL2_ACTOR_DENIED', 'BILL2_POLICY_DENIED', 'BILL2_PREDEDUCT_CONFLICT',
  'RUNTIME_RESUME_CONFLICT', 'RUNTIME_CHECKPOINT_CONFLICT', 'RUNTIME_STOP_REQUESTED',
  'RUNTIME_TEST_BUDGET_EXHAUSTED', 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED',
  'REPORT_MEMBERSHIP_REQUIRED', 'REPORT_ENTITLEMENTS_UNAVAILABLE', 'REPORT_SOURCE_CONFLICT',
])('maps verified %s to fixed Chinese text without raw details', reason => {
  const error = claimFailure({ message: reason, detail: 'private SQL', hint: 'private actor' });
  const notice = billingClaimNotice(error);
  expect(notice).toMatch(/[\u4e00-\u9fff]/);
  expect(notice).not.toMatch(/BILL2_|RUNTIME_|REPORT_|private/);
});

it.each([
  new Error('BILL2_START_THRESHOLD_UNCONFIGURED'),
  new BillingClaimRejection('unknown private message'),
  new BillingClaimRejection('constructor'),
  new BillingClaimRejection('BILL2_START_THRESHOLD_UNCONFIGURED: private'),
  { reason: 'BILL2_START_THRESHOLD_UNCONFIGURED' },
  null,
])('never trusts arbitrary errors or inherited properties: %j', error => {
  expect(billingClaimNotice(error)).toBeUndefined();
});

it('uses the explicit credit-wait state and preserves stronger existing notices', () => {
  expect(withClaimNotice({ state: 'waiting_credits', cursor: 3 })).toEqual({ state: 'waiting_credits', cursor: 3,
    notice: '余额不足，任务已暂停，请补充积分后继续。' });
  for (const state of ['pending', 'cancelled', 'cost_pending', 'completed', 'waiting_resume'])
    expect(withClaimNotice({ state })).toEqual({ state });
  const config = { state: 'waiting_credits', unavailable: 'RUNTIME_PRICE_CONFIGURATION_PENDING' };
  expect(withClaimNotice(config)).toBe(config);
  const prior = { state: 'waiting_credits', notice: '已核实的提示' };
  expect(withClaimNotice(prior)).toBe(prior);
});
