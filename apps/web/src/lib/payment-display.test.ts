/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_REQUIRED_FACT_KINDS, USER_AMOUNT_FACT_KINDS, UNKNOWN_AMOUNT, buildAmountFactRows, formatAmountFact,
  formatMinorAmount, getDocumentStatusPresentation, getPaymentChannelLabel,
} from './payment-display';

describe('document status', () => {
  it('keeps unknown and unavailable visibly different and never reads unknown as no document', () => {
    const unknown = getDocumentStatusPresentation('unknown');
    const unavailable = getDocumentStatusPresentation('unavailable');
    expect(unknown.label).not.toBe(unavailable.label);
    expect(unknown.tone).not.toBe(unavailable.tone);
    expect(unknown.label).not.toMatch(/无凭证|没有/);
    expect(getDocumentStatusPresentation('available').label).toBe('凭证可查看');
  });

  it('treats a missing or unexpected status as unknown', () => {
    for (const value of [undefined, null, '', 'none', 'AVAILABLE']) {
      expect(getDocumentStatusPresentation(value as string)).toEqual(getDocumentStatusPresentation('unknown'));
    }
  });
});

describe('amount facts', () => {
  it('shows null amounts as unknown, never 0', () => {
    expect(formatAmountFact(null, 'usd')).toBe(UNKNOWN_AMOUNT);
    expect(formatAmountFact('', 'usd')).toBe(UNKNOWN_AMOUNT);
    expect(formatAmountFact('0', 'usd')).toBe('USD 0');
  });

  it('keeps the exact decimal string', () => {
    expect(formatAmountFact('12.345678901234', 'usd')).toBe('USD 12.345678901234');
  });

  it('adds missing required admin facts as unknown', () => {
    const rows = buildAmountFactRows([{ kind: 'paid', amount: '9.90', currency: 'usd', unit: 'major' },
      { kind: 'fee', amount: null, currency: 'usd', unit: 'major' }], { required: ADMIN_REQUIRED_FACT_KINDS });
    expect(rows).toEqual([
      { kind: 'paid', label: '实付', value: 'USD 9.90' },
      { kind: 'fee', label: '渠道手续费', value: UNKNOWN_AMOUNT },
      { kind: 'net', label: '到账净额', value: UNKNOWN_AMOUNT },
    ]);
  });

  it('hides merchant-side fee and net from buyers', () => {
    const rows = buildAmountFactRows([{ kind: 'paid', amount: '9.90', currency: 'usd', unit: 'major' },
      { kind: 'fee', amount: '0.59', currency: 'usd', unit: 'major' },
      { kind: 'net', amount: '9.31', currency: 'usd', unit: 'major' }], { allowed: USER_AMOUNT_FACT_KINDS });
    expect(rows.map(row => row.kind)).toEqual(['paid']);
  });

  it('shows a payment recorded by both checkout session and first invoice once', () => {
    // Shape of the staging subscription orders: paid/fee/net from cs_ evidence, then again from in_ evidence.
    const once = [{ kind: 'paid', amount: '29.90' }, { kind: 'fee', amount: null }, { kind: 'net', amount: null }]
      .map(fact => ({ ...fact, currency: 'usd', unit: 'major' as const }));
    const facts = [...once, ...once];
    expect(buildAmountFactRows(facts, { required: ADMIN_REQUIRED_FACT_KINDS })).toEqual([
      { kind: 'paid', label: '实付', value: 'USD 29.90' },
      { kind: 'fee', label: '渠道手续费', value: UNKNOWN_AMOUNT },
      { kind: 'net', label: '到账净额', value: UNKNOWN_AMOUNT },
    ]);
    expect(buildAmountFactRows(facts, { allowed: USER_AMOUNT_FACT_KINDS })).toEqual([
      { kind: 'paid', label: '实付', value: 'USD 29.90' },
    ]);
  });

  it('lets a later known value replace an unknown one of the same kind', () => {
    const rows = buildAmountFactRows([{ kind: 'fee', amount: null, currency: 'usd', unit: 'major' },
      { kind: 'fee', amount: '0.59', currency: 'usd', unit: 'major' }]);
    expect(rows).toEqual([{ kind: 'fee', label: '渠道手续费', value: 'USD 0.59' }]);
  });

  it('keeps different known values of one kind, numbered, instead of dropping one', () => {
    const rows = buildAmountFactRows([{ kind: 'paid', amount: '29.90', currency: 'usd', unit: 'major' },
      { kind: 'paid', amount: null, currency: 'usd', unit: 'major' },
      { kind: 'paid', amount: '9.90', currency: 'usd', unit: 'major' }]);
    expect(rows).toEqual([
      { kind: 'paid', label: '实付（第 1 条记录）', value: 'USD 29.90' },
      { kind: 'paid', label: '实付（第 2 条记录）', value: 'USD 9.90' },
    ]);
    expect(new Set(rows.map(row => row.label)).size).toBe(rows.length);
  });

  it('handles a missing facts list', () => {
    expect(buildAmountFactRows(undefined)).toEqual([]);
    expect(buildAmountFactRows(null, { required: ['net'] })).toEqual([{ kind: 'net', label: '到账净额', value: UNKNOWN_AMOUNT }]);
  });
});

describe('minor amounts', () => {
  it('divides by the currency minor unit, not a fixed 100', () => {
    expect(formatMinorAmount(990, 'usd')).toBe('$9.90');
    expect(formatMinorAmount(990, 'jpy')).toBe('¥990');
    expect(formatMinorAmount('1500', 'USD')).toBe('$15.00');
  });

  it('shows unknown for missing amounts or currency, never 0', () => {
    expect(formatMinorAmount(null, 'usd')).toBe(UNKNOWN_AMOUNT);
    expect(formatMinorAmount(undefined, 'usd')).toBe(UNKNOWN_AMOUNT);
    expect(formatMinorAmount(100, null)).toBe(UNKNOWN_AMOUNT);
    expect(formatMinorAmount('abc', 'usd')).toBe(UNKNOWN_AMOUNT);
  });

  it('falls back to the raw minor amount for an unrecognised currency code', () => {
    expect(formatMinorAmount(100, 'x1')).toBe('X1 100（最小单位）');
  });
});

it('labels a missing channel as unknown', () => {
  expect(getPaymentChannelLabel(null)).toBe('未知渠道');
  expect(getPaymentChannelLabel('Stripe')).toBe('Stripe');
});
