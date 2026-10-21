/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect } from 'vitest';
import { walletMembershipTerm, membershipGrantWindows, founderGraceDeadline, assertProUpgradeWindow } from './methodMembershipTerm';
describe('method membership terms', () => {
  it.each(['month', 'year'] as const)('wallet advance %s retains the paid period and starts at its end', term => {
    const result = walletMembershipTerm({ paidAt: '2028-01-05T08:00:00Z', term,
      walletRenewal: { originalEnd: '2028-01-31T08:00:00Z' } });
    expect(result).toEqual({ start: '2028-01-31T08:00:00.000Z',
      end: term === 'year' ? '2029-01-31T08:00:00.000Z' : '2028-02-29T08:00:00.000Z' });
    const windows = membershipGrantWindows({ orderId: 'renewal', ...result, yearly: term === 'year',
      credits: term === 'year' ? 41760 : 3480 });
    expect(windows[0]?.start).toBe(result.start);
    expect(windows.every(window => Date.parse(window.start) > Date.parse('2028-01-05T08:00:00Z'))).toBe(true);
  });
  it('rejects first-month offers or mixed founder rules on an ordinary wallet renewal', () => {
    const walletRenewal = { originalEnd: '2028-01-31T08:00:00Z' };
    expect(() => walletMembershipTerm({ paidAt: '2028-01-05T08:00:00Z', term: 'days30', walletRenewal }))
      .toThrow('PAY_WAFFO_TERM_INVALID');
    expect(() => walletMembershipTerm({ paidAt: '2028-01-05T08:00:00Z', term: 'year', walletRenewal,
      founderRenewal: { ...walletRenewal, eligibleUntil: '2028-02-07T08:00:00Z' } })).toThrow('PAY_WAFFO_TERM_INVALID');
  });
  it('preserves month-end and leap-year anchors across twelve grants', () => {
    const term = walletMembershipTerm({ paidAt: '2028-01-31T08:00:00Z', term: 'year' });
    const grants = membershipGrantWindows({ orderId: 'order', ...term, yearly: true, credits: 107640 });
    expect(grants).toHaveLength(12); expect(grants.reduce((n, g) => n + g.credits, 0)).toBe(107640);
    expect(grants.every(g => g.credits === 8970)).toBe(true);
    expect(grants[0]?.end).toBe('2028-02-29T08:00:00.000Z');
    expect(grants[1]?.end).toBe('2028-03-31T08:00:00.000Z');
    expect(grants.at(-1)?.end).toBe('2029-01-31T08:00:00.000Z');
    expect(walletMembershipTerm({ paidAt: '2028-02-29T08:00:00Z', term: 'year' }).end).toBe('2029-02-28T08:00:00.000Z');
  });
  it('first offer is exactly 30 days, not one calendar month', () => {
    expect(walletMembershipTerm({ paidAt: '2027-01-31T08:00:00Z', term: 'days30' }).end).toBe('2027-03-02T08:00:00.000Z');
    expect(walletMembershipTerm({ paidAt: '2027-01-31T08:00:00Z', term: 'month' }).end).toBe('2027-02-28T08:00:00.000Z');
  });
  it.each(['2027-01-29T00:00:00Z', '2027-02-06T00:00:00Z'])('founder renewal at %s starts at original end', paidAt => {
    expect(walletMembershipTerm({ paidAt, term: 'year', founderRenewal: {
      originalEnd: '2027-01-31T00:00:00Z', eligibleUntil: '2027-02-07T00:00:00Z' },
    })).toEqual({ start: '2027-01-31T00:00:00.000Z', end: '2028-01-31T00:00:00.000Z' });
  });
  it('does not revive expired founder eligibility', () => {
    expect(() => walletMembershipTerm({ paidAt: '2027-02-07T00:00:01Z', term: 'year', founderRenewal: {
      originalEnd: '2027-01-31T00:00:00Z', eligibleUntil: '2027-02-07T00:00:00Z' },
    })).toThrow('PAY_WAFFO_FOUNDER_EXPIRED');
  });
  it('unions duplicate outages and pauses only remaining grace', () => {
    const start = '2027-01-01T00:00:00Z';
    expect(founderGraceDeadline({ failedRenewalAt: start, now: '2027-01-20T00:00:00Z', outages: [
      { start: '2027-01-04T00:00:00Z', end: '2027-01-06T00:00:00Z' },
      { start: '2027-01-04T00:00:00Z', end: '2027-01-07T00:00:00Z' },
      { start: '2027-01-12T00:00:00Z', end: '2027-01-19T00:00:00Z' },
    ] })).toBe('2027-01-11T00:00:00.000Z');
    expect(founderGraceDeadline({ failedRenewalAt: start, now: '2027-01-20T00:00:00Z', outages: [
      { start: '2026-12-31T00:00:00Z', end: null },
    ] })).toBe('2027-01-27T00:00:00.000Z');
  });
  it('blocks upgrades within 48h, retries, unknown state and excessive session life', () => {
    const input = { now: '2027-01-01T00:00:00Z', nextChargeAt: '2027-01-03T00:30:01Z',
      retrying: false, stateKnown: true, checkoutExpiresAt: '2027-01-01T00:30:00Z' };
    expect(() => assertProUpgradeWindow(input)).not.toThrow();
    for (const change of [{ nextChargeAt: '2027-01-03T00:30:00Z' }, { nextChargeAt: '2027-01-03T00:00:00Z' }, { retrying: true }, { stateKnown: false },
      { nextChargeAt: null }, { checkoutExpiresAt: '2027-01-02T00:00:00Z' }]) {
      expect(() => assertProUpgradeWindow({ ...input, ...change })).toThrow('PAY_WAFFO_UPGRADE_WAIT');
    }
  });
});
