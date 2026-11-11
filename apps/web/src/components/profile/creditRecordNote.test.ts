/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { creditRecordNote } from './creditLedgerPresentation';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

// Walkthrough 2026-11-11, item 6: a new user's credit records said "AI turn" under every spend and
// "Opening grant for new user profile bootstrap" under the sign-up gift.
describe('creditRecordNote', () => {
  it('shows the sign-up gift in Chinese', () => {
    expect(creditRecordNote('Opening grant for new user profile bootstrap')).toBe('新用户赠送');
    expect(creditRecordNote('Opening grant already claimed by this identity')).toBe('新用户赠送已经领过');
  });

  it('shows no second line for an ordinary AI spend: the label above already says it', () => {
    expect(creditRecordNote('AI turn')).toBe('');
    expect(creditRecordNote(' AI turn ')).toBe('');
  });

  it('says in Chinese that a freeze was not returned', () => {
    expect(creditRecordNote('AI turn freeze not returned (subscription refunded or ended)')).toBe('冻结的积分没有退回（订阅已退款或已结束）');
  });

  it('keeps every other description as written, and nothing for none', () => {
    expect(creditRecordNote('每周复盘')).toBe('每周复盘');
    expect(creditRecordNote('会员每月积分')).toBe('会员每月积分');
    expect(creditRecordNote(null)).toBe('');
    expect(creditRecordNote(undefined)).toBe('');
    expect(creditRecordNote('toString')).toBe('toString');
  });

  it('no English internal description written by the database functions reaches the page untranslated', () => {
    const sql = ['turn/turn_settle_credits.sql', 'turn/turn_open.sql', 'turn/turn_call_begin.sql', 'other/opening_grant_remember.sql']
      .map(name => readFileSync(fileURLToPath(new URL(`../../../../../packages/db/functions/${name}`, import.meta.url)), 'utf8')).join('\n');
    const written = [...new Set([...sql.matchAll(/'((?:AI turn|Opening grant)[^']*)'/g)].map(match => match[1]!))];
    expect(written.length).toBeGreaterThanOrEqual(3);
    for (const text of written) expect(creditRecordNote(text), text).not.toMatch(/[A-Za-z]{3}/);
  });
});

it('the credit records card shows the note, not the raw description', () => {
  const card = read('CreditRecordsCard.tsx');
  expect(card).toContain('{creditRecordNote(tx.description)}');
  expect(card).not.toContain("{tx.description || '-'}");
});

// Walkthrough item 10: the pricing page says "积分包", the member page said "积分加油包".
it('the member pages call the product 积分包, as the pricing page does', () => {
  for (const name of ['CreditPackagesSection.tsx', 'PersonalInfoCard.tsx', 'SubscriptionCard.tsx']) {
    const shown = read(name).split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('{/*')).join('\n');
    expect(shown, name).not.toContain('加油包');
  }
  expect(read('CreditPackagesSection.tsx')).toContain('>积分包</h3>');
});
