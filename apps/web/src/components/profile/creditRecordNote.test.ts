/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // Review of #1907: also written when a WeChat Pay or Alipay payment is refunded, so the note names no payment method.
    expect(creditRecordNote('External card refund')).toBe('订单退款');
    expect(creditRecordNote('External card refund')).not.toContain('银行卡');
    expect(creditRecordNote('Failed cash refund credit restoration')).toBe('退款没有成功，积分已恢复');
    expect(creditRecordNote('Payment dispute hold')).toBe('付款争议处理中，积分暂时冻结');
    // Lifting the hold does not say the dispute is over (review of #1907).
    expect(creditRecordNote('Payment dispute hold withdrawn')).toBe('付款争议的冻结已撤销，积分已恢复');
    expect(creditRecordNote('Payment dispute hold withdrawn')).not.toContain('解除');
  });
});

/**
 * Every description the database has written into the credit records, old ones included (users' older rows keep older texts): none
 * may reach the page in English.
 *
 * Reading all of packages/db (about 1,350 files) took close to four seconds, most of a test's time limit, so the check does not do
 * that. It rests on two repository rules instead (docs/ENGINEERING.md): migrations are append-only, and a database function changes
 * only through a new migration carrying its whole new text. So:
 *  - what the migrations up to AUDITED.through contain can no longer change: the full scan of 2026-11-12 is kept here as AUDITED_TEXTS;
 *  - anything new arrives in a migration with a higher number, and only those files are read (none on the day of the audit).
 * A migration that lands later under an already audited number changes the file count: the check then fails until the audit is redone
 * (FULL_LEDGER_SCAN=1 runs the full scan below and says what the list misses).
 */
const AUDITED = { through: 521, files: 478 };
const AUDITED_TEXTS = [
  'AI call consumption', 'AI run consumption', 'AI turn', 'AI turn freeze', 'AI turn freeze not returned (subscription refunded or ended)',
  'AI turn freeze top-up', 'AI 对话中断结算', 'AI 对话消费', 'Approved package refund', 'Call reservation', 'Call reservation release',
  'Confirmed failure compensation', 'Expert review', 'Expert review hold', 'Expert review hold release', 'External card refund',
  'Failed cash refund credit restoration', 'Opening grant already claimed by this identity', 'Opening grant for new user profile bootstrap',
  'Payment dispute hold', 'Payment dispute hold withdrawn', 'Payment dispute in-flight adjustment', 'Positioning report',
  'Refunded credit pack settled', 'Refunded credit pack settled (returned reservation)', 'Refunded dispute reservation return', 'Report hold',
  'Report hold release', 'Research cancelled before dispatch', 'Research provider returned a terminal error', 'Run reservation',
  'Run reservation release', 'Skill model call', 'Stripe refund credit clawback [order:%s refund:%s shortfall:%s]',
  'Stripe subscription refund credit clawback [subscription:%s refund:%s grants:1]', 'Web search / social data lookup',
  'Workbench AI generation', 'Workbench web search',
];
const db = (path: string) => fileURLToPath(new URL(`../../../../../packages/db/${path}`, import.meta.url));
const migrationNumber = (name: string) => Number(/^(\d+)_/.exec(name)?.[1] ?? Number.POSITIVE_INFINITY);
/** The descriptions in a piece of SQL: the text right after a ledger type, or one that begins like the known families. A quote may be
 *  doubled (SQL inside a quoted string, as older migrations and EXECUTE write it). */
function ledgerTexts(sql: string) {
  const beside = /'{1,2}(?:consumption|adjustment|addition|deduction|purchase|refund|bonus|grant|usage|membership)'{1,2},\s*'{1,2}([A-Za-z][^'\n]*\s[^'\n]*)'{1,2}/g;
  const named = /'{1,2}((?:AI (?:turn|call|run)|Opening grant|Web search|Research (?:cancelled|provider)|Stripe (?:subscription )?refund credit clawback)[^'\n]*)'{1,2}/g;
  return [...new Set([...sql.matchAll(beside), ...sql.matchAll(named)].map(match => match[1]!))];
}

describe('the database sources', () => {
  it('none of the descriptions found by the full audit reaches the page untranslated', () => {
    expect(AUDITED_TEXTS).toHaveLength(38);
    for (const text of AUDITED_TEXTS) expect(creditRecordNote(text), text).not.toMatch(/[A-Za-z]{3}/);
  });

  it('a migration added after the audit brings no new English description', () => {
    const names = readdirSync(db('migrations')).filter(name => name.endsWith('.sql'));
    expect(names.filter(name => migrationNumber(name) <= AUDITED.through),
      'a migration was added under an already audited number: redo the audit (FULL_LEDGER_SCAN=1) and update AUDITED').toHaveLength(AUDITED.files);
    const added = names.filter(name => migrationNumber(name) > AUDITED.through);
    const written = ledgerTexts(added.map(name => readFileSync(db(`migrations/${name}`), 'utf8')).join('\n'));
    for (const text of written) expect(creditRecordNote(text), text).not.toMatch(/[A-Za-z]{3}/);
  });

  // The audit itself, run by hand when AUDITED has to move: every migration and every function file. Not part of the ordinary run.
  it.runIf(process.env.FULL_LEDGER_SCAN === '1')('full scan: AUDITED_TEXTS is everything the sources hold', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.sql') ? [join(dir, entry.name)] : []);
    const found = ledgerTexts([...files(db('functions')), ...files(db('migrations'))].map(file => readFileSync(file, 'utf8')).join('\n'));
    expect(found.filter(text => !AUDITED_TEXTS.includes(text)).sort()).toEqual([]);
    expect(AUDITED_TEXTS.filter(text => !found.includes(text)).sort()).toEqual([]);
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
