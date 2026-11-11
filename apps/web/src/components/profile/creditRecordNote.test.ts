/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
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

  // The validation of #1892 on staging found older records still in English: "AI call consumption", "Confirmed failure compensation".
  it('shows the older billing descriptions in Chinese too', () => {
    expect(creditRecordNote('AI call consumption')).toBe('');
    expect(creditRecordNote('AI run consumption')).toBe('');
    expect(creditRecordNote('Confirmed failure compensation')).toBe('调用失败，积分已退回');
    expect(creditRecordNote('Web search / social data lookup')).toBe('联网搜索和社媒数据查询');
    expect(creditRecordNote('Positioning report')).toBe('运营策略报告');
    expect(creditRecordNote('Paid credit package')).toBe('购买积分包');
  });

  it('names a refund or a dispute without its internal ids', () => {
    expect(creditRecordNote('Stripe refund credit clawback [order:ord_1 refund:re_1 shortfall:0]')).toBe('订单退款');
    expect(creditRecordNote('Stripe subscription refund credit clawback [subscription:sub_1 refund:re_1 grants:1]')).toBe('会员退款');
    expect(creditRecordNote('Approved package refund')).toBe('积分包退款');
    expect(creditRecordNote('Failed cash refund credit restoration')).toBe('退款没有成功，积分已恢复');
    expect(creditRecordNote('Payment dispute hold')).toBe('付款争议处理中，积分暂时冻结');
    // Lifting the hold does not say the dispute is over (review of #1907).
    expect(creditRecordNote('Payment dispute hold withdrawn')).toBe('付款争议的冻结已撤销，积分已恢复');
    expect(creditRecordNote('Payment dispute hold withdrawn')).not.toContain('解除');
  });
});

// Every description the database has ever written beside a ledger type, in the functions and in all migrations (old rows keep
// old texts): none may reach the page in English. A new English description added to the database turns this red.
describe('the database sources', () => {
  let sql = '';
  // About 1,400 files: read together, once, before the check (a cold disk made a one-by-one read inside the test too slow).
  beforeAll(async () => {
    const root = fileURLToPath(new URL('../../../../../packages/db/', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.sql') ? [join(dir, entry.name)] : []);
    const all = [...files(join(root, 'functions')), ...files(join(root, 'migrations'))];
    sql = (await Promise.all(all.map(file => readFile(file, 'utf8')))).join('\n');
  });

  it('no English description written by the database, now or in any earlier migration, reaches the page untranslated', () => {
    const beside = /'(?:consumption|adjustment|addition|deduction|purchase|refund|bonus|grant|usage|membership)',\s*'([A-Za-z][^'\n]*\s[^'\n]*)'/g;
    const named = /'((?:AI (?:turn|call|run)|Opening grant|Web search|Research (?:cancelled|provider)|Stripe (?:subscription )?refund credit clawback)[^'\n]*)'/g;
    const written = [...new Set([...sql.matchAll(beside), ...sql.matchAll(named)].map(match => match[1]!))];
    expect(written.length).toBeGreaterThanOrEqual(30);
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
