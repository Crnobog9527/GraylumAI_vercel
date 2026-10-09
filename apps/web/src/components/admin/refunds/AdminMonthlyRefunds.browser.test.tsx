/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const ORDER = '11111111-1111-4111-8111-111111111111';
const TICKET = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';
const entry = fileURLToPath(new URL('./__monthly_refund_fixture__.js', import.meta.url));

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./AdminMonthlyRefunds.tsx', import.meta.url));
  // Server double: window.calls records every request; window.mode.<name> = 'fail' | 'hang'.
  const mock = `
    import {useState} from 'react';
    window.calls = []; window.mode = {}; window.release = {};
    const server = async (name, input) => {
      window.calls.push([name, input]);
      if (window.mode[name] === 'hang') await new Promise(r => { window.release[name] = r; });
      if (String(window.mode[name] ?? '').startsWith('code:')) throw Object.assign(new Error(window.mode[name].slice(5)),
        {data:{code:'BAD_REQUEST'}});
      if (window.mode[name] === 'fail') throw Object.assign(new Error('退款证据不足或状态已变化，请重新核对订单与工单'),
        {data:{code:'INTERNAL_SERVER_ERROR'}});
      return window.responses[name];
    };
    const mutation = name => () => {
      const [isPending, setPending] = useState(false);
      return {isPending, mutateAsync: async input => {
        setPending(true);
        try { return await server(name, input); } finally { setPending(false); }
      }};
    };
    export const trpc = {
      useUtils: () => ({admin: {
        quoteMonthlyRefund: {fetch: input => server('quote', input)},
        getMonthlyRefundStatus: {fetch: input => server('status', input)},
      }}),
      admin: {
        approveMonthlyRefund: {useMutation: mutation('approve')},
        executeMonthlyRefund: {useMutation: mutation('execute')},
        rejectMonthlyRefund: {useMutation: mutation('reject')},
      },
    };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'monthly-refund-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0refund-trpc';
    }, load(id: string) {
      if (id === '\0refund-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {AdminMonthlyRefunds} from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(AdminMonthlyRefunds));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'MonthlyRefundTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

const terms = {
  kind: 'monthly_first_purchase', orderId: ORDER, ticketId: TICKET, plan: 'gold', currency: 'usd', mode: 'test',
  paidMinor: 6900, basisMinor: 6900, feeMinor: 414, netMinor: 6486, credits: 8970, paidAt: '2026-10-05T00:00:00Z',
  submittedAt: '2026-10-07T00:00:00Z', periodEnd: '2026-11-05T00:00:00Z', feePermitted: 'confirmed',
  feeEvidence: 'legal:us-ca:2026-10', evidenceRefs: ['a', 'b', 'c', 'd'],
};
const quote = { terms, versionHash: 'a'.repeat(64), localVersion: 'b'.repeat(32), executable: false };
const approved = { kind: 'monthly_first_purchase', id: INTENT, status: 'approved', terms, hold: 'none', claimedAt: null,
  approvedAt: '2026-10-08T00:00:00Z', started: { stop_renewal: null, refund: null, cancel: null, restore_renewal: null } };

async function open(responses: Record<string, unknown> = {}) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(value => { Object.assign(window, { responses: value }); }, responses);
  await page.addScriptTag({ content: code });
  return { page, errors };
}

async function fill(page: Page, fee: string = '法律允许，扣 6% 手续费') {
  await page.getByLabel('订单编号').fill(ORDER);
  await page.getByLabel('工单编号').fill(TICKET);
  await page.getByLabel('能否扣 6% 手续费').click();
  await page.getByRole('option', { name: fee }).click();
  await page.getByLabel('手续费核对依据').fill('legal:us-ca:2026-10');
}

const calls = (page: Page) => page.evaluate('window.calls') as Promise<Array<[string, unknown]>>;

it('checks the form locally and never calls the server with invalid input', async () => {
  const { page, errors } = await open();
  try {
    await page.getByTestId('monthly-refund-quote-button').click();
    await browserExpect(page.getByText('请填写完整的订单编号', { exact: false })).toBeVisible();
    await browserExpect(page.getByText('请先确认当地法律是否允许扣手续费')).toBeVisible();
    expect(await calls(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('shows the server refusal in plain Chinese with likely causes and no approve button', async () => {
  const { page, errors } = await open();
  try {
    await page.evaluate(() => { (window as unknown as { mode: Record<string, string> }).mode.quote = 'fail'; });
    await fill(page);
    await page.getByTestId('monthly-refund-quote-button').click();
    const error = page.getByTestId('monthly-refund-quote-error');
    await browserExpect(error).toContainText('拿不到报价：退款证据不足或状态已变化，请重新核对订单与工单');
    await browserExpect(error).toContainText('超过 7 天');
    await browserExpect(page.getByTestId('monthly-refund-approve')).toHaveCount(0);
    await browserExpect(page.getByTestId('monthly-refund-reject')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('approves only after confirmation, pinned to the displayed quote, then executes separately once', async () => {
  const claimed = { ...approved, status: 'review_required', claimedAt: '2026-10-09T00:00:00Z', hold: 'held',
    started: { ...approved.started, stop_renewal: '2026-10-09T00:00:01Z' } };
  const { page, errors } = await open({ quote, approve: approved, status: claimed,
    execute: { status: 'review_required', intentId: INTENT, decision: { kind: 'review_required', reason: 'amount_mismatch' } } });
  try {
    await fill(page);
    await page.getByTestId('monthly-refund-quote-button').click();
    const card = page.getByTestId('monthly-refund-quote');
    await browserExpect(card).toContainText('$64.86');
    await browserExpect(card).toContainText('$4.14');
    await browserExpect(card).toContainText('8,970 积分');
    // Cancelling the confirmation sends nothing.
    await page.getByTestId('monthly-refund-approve').click();
    await page.getByRole('button', { name: '再想想' }).click();
    expect((await calls(page)).map(([name]) => name)).toEqual(['quote']);

    await page.evaluate(() => { (window as unknown as { mode: Record<string, string> }).mode.approve = 'hang'; });
    await page.getByTestId('monthly-refund-approve').click();
    await page.getByTestId('monthly-refund-approve-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-approve')).toBeDisabled();
    await browserExpect(page.getByTestId('monthly-refund-approve')).toHaveText('正在批准…');
    await page.evaluate(() => { (window as unknown as { release: Record<string, () => void> }).release.approve(); });
    await browserExpect(page.getByTestId('monthly-refund-status-label')).toHaveText('已批准，等待执行');

    await page.getByTestId('monthly-refund-execute').click();
    await browserExpect(page.getByRole('alertdialog')).toContainText('$64.86');
    await page.getByTestId('monthly-refund-execute-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-execute-stopped')).toContainText('金额和批准时不一致');
    // The stored intent moved on (claimed, a stage started): the card shows the re-read state.
    await browserExpect(page.getByTestId('monthly-refund-status-label')).toHaveText('执行中或需要人工核对');
    // amount_mismatch needs a person: no further execute is offered.
    await browserExpect(page.getByTestId('monthly-refund-execute')).toHaveCount(0);
    await browserExpect(page.getByTestId('monthly-refund-execute-stopped')).toContainText('需要人工核对后处理');
    await browserExpect(page.getByTestId('monthly-refund-status')).toContainText('已开始');
    expect(await calls(page)).toEqual([
      ['quote', { orderId: ORDER, ticketId: TICKET, feePermitted: 'confirmed', feeEvidence: 'legal:us-ca:2026-10' }],
      ['approve', { orderId: ORDER, ticketId: TICKET, feePermitted: 'confirmed', feeEvidence: 'legal:us-ca:2026-10',
        versionHash: quote.versionHash, localVersion: quote.localVersion }],
      ['execute', { orderId: ORDER, intentId: INTENT }],
      ['status', { orderId: ORDER }],
    ]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('drops a shown quote as soon as the admin edits the form', async () => {
  const { page, errors } = await open({ quote });
  try {
    await fill(page);
    await page.getByTestId('monthly-refund-quote-button').click();
    await browserExpect(page.getByTestId('monthly-refund-quote')).toBeVisible();
    await page.getByLabel('手续费核对依据').fill('legal:us-ny:2026-10');
    await browserExpect(page.getByTestId('monthly-refund-quote')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('rejects with the chosen reason after confirmation and hides reject once rejected', async () => {
  const rejected = { kind: 'monthly_first_purchase', id: INTENT, status: 'rejected', rejectionReason: 'ineligible',
    rejectedAt: '2026-10-09T00:00:00Z' };
  const { page, errors } = await open({ reject: rejected });
  try {
    await fill(page, '法律不允许，不扣手续费');
    await browserExpect(page.getByTestId('monthly-refund-reject-button')).toBeDisabled();
    await page.getByLabel('拒绝原因').click();
    await page.getByRole('option', { name: '不符合退款条件' }).click();
    await page.getByTestId('monthly-refund-reject-button').click();
    await page.getByTestId('monthly-refund-reject-button-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-status-label')).toHaveText('已拒绝');
    await browserExpect(page.getByTestId('monthly-refund-status')).toContainText('不符合退款条件');
    await browserExpect(page.getByTestId('monthly-refund-reject')).toHaveCount(0);
    await browserExpect(page.getByTestId('monthly-refund-execute')).toHaveCount(0);
    expect(await calls(page)).toEqual([['reject', { orderId: ORDER, ticketId: TICKET, reason: 'ineligible' }]]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('locks the form while a quote is pending and shows the quoted identifiers in the confirmation', async () => {
  const { page, errors } = await open({ quote });
  try {
    await page.evaluate(() => { (window as unknown as { mode: Record<string, string> }).mode.quote = 'hang'; });
    await fill(page);
    await page.getByTestId('monthly-refund-quote-button').click();
    await browserExpect(page.getByLabel('订单编号')).toBeDisabled();
    await browserExpect(page.getByLabel('手续费核对依据')).toBeDisabled();
    await page.evaluate(() => { (window as unknown as { release: Record<string, () => void> }).release.quote(); });
    await browserExpect(page.getByTestId('monthly-refund-quote-ids')).toContainText(ORDER);
    await page.getByTestId('monthly-refund-approve').click();
    await browserExpect(page.getByRole('alertdialog')).toContainText(TICKET);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('reads progress with only an order id and hides execute after a recorded cash conflict', async () => {
  const { page, errors } = await open({ status: approved,
    execute: { status: 'review_required', intentId: INTENT, reason: 'recorded_cash_conflict' } });
  try {
    await page.getByLabel('订单编号').fill(ORDER);
    await page.getByTestId('monthly-refund-status-button').click();
    await browserExpect(page.getByTestId('monthly-refund-status-label')).toHaveText('已批准，等待执行');
    await page.getByTestId('monthly-refund-execute').click();
    await page.getByTestId('monthly-refund-execute-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-conflict')).toBeVisible();
    await browserExpect(page.getByTestId('monthly-refund-execute')).toHaveCount(0);
    expect(await calls(page)).toEqual([['status', { orderId: ORDER }], ['execute', { orderId: ORDER, intentId: INTENT }],
      ['status', { orderId: ORDER }]]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('rejects with only the order and ticket filled in', async () => {
  const { page, errors } = await open({ reject: { kind: 'monthly_first_purchase', id: INTENT, status: 'rejected',
    rejectionReason: 'customer_withdrew' } });
  try {
    await page.getByLabel('订单编号').fill(ORDER);
    await page.getByLabel('工单编号').fill(TICKET);
    await page.getByLabel('拒绝原因').click();
    await page.getByRole('option', { name: '用户撤回了申请' }).click();
    await page.getByTestId('monthly-refund-reject-button').click();
    await page.getByTestId('monthly-refund-reject-button-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-status-label')).toHaveText('已拒绝');
    expect(await calls(page)).toEqual([['reject', { orderId: ORDER, ticketId: TICKET, reason: 'customer_withdrew' }]]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('clears a picked rejection reason as soon as the order or ticket changes', async () => {
  const { page, errors } = await open();
  try {
    await page.getByLabel('订单编号').fill(ORDER);
    await page.getByLabel('工单编号').fill(TICKET);
    await page.getByLabel('拒绝原因').click();
    await page.getByRole('option', { name: '不符合退款条件' }).click();
    await browserExpect(page.getByTestId('monthly-refund-reject-button')).toBeEnabled();
    await page.getByLabel('工单编号').fill('44444444-4444-4444-8444-444444444444');
    await browserExpect(page.getByTestId('monthly-refund-reject-button')).toBeDisabled();
    await browserExpect(page.getByLabel('拒绝原因')).toContainText('选择拒绝原因');
    expect(await calls(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('keeps "继续执行" after a stop the executor can retry by itself', async () => {
  const claimed = { ...approved, status: 'review_required', claimedAt: '2026-10-09T00:00:00Z', hold: 'held' };
  const { page, errors } = await open({ status: claimed,
    execute: { status: 'review_required', intentId: INTENT, decision: { kind: 'pending', refundId: 're_1' } } });
  try {
    await page.getByLabel('订单编号').fill(ORDER);
    await page.getByTestId('monthly-refund-status-button').click();
    await page.getByTestId('monthly-refund-execute').click();
    await page.getByTestId('monthly-refund-execute-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-execute-stopped')).toContainText('还在处理中');
    await browserExpect(page.getByTestId('monthly-refund-execute')).toHaveText('继续执行');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('after an execute request with an uncertain result, offers nothing to execute until progress is read again', async () => {
  const { page, errors } = await open({ status: approved });
  try {
    await page.getByLabel('订单编号').fill(ORDER);
    await page.getByTestId('monthly-refund-status-button').click();
    await page.evaluate(() => { (window as unknown as { mode: Record<string, string> }).mode.execute = 'fail'; });
    await page.getByTestId('monthly-refund-execute').click();
    await page.getByTestId('monthly-refund-execute-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-action-error')).toContainText('查看进度');
    await browserExpect(page.getByTestId('monthly-refund-execute')).toHaveCount(0);
    await page.getByTestId('monthly-refund-status-button').click();
    await browserExpect(page.getByTestId('monthly-refund-execute')).toBeVisible();
    expect((await calls(page)).map(([name]) => name)).toEqual(['status', 'execute', 'status']);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('after an uncertain execute in the same session, neither approve nor execute stays clickable', async () => {
  const { page, errors } = await open({ quote, approve: approved, status: approved });
  try {
    await fill(page);
    await page.getByTestId('monthly-refund-quote-button').click();
    await page.getByTestId('monthly-refund-approve').click();
    await page.getByTestId('monthly-refund-approve-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-status-label')).toHaveText('已批准，等待执行');
    await page.evaluate(() => { (window as unknown as { mode: Record<string, string> }).mode.execute = 'fail'; });
    await page.getByTestId('monthly-refund-execute').click();
    await page.getByTestId('monthly-refund-execute-confirm').click();
    await browserExpect(page.getByTestId('monthly-refund-action-error')).toBeVisible();
    await browserExpect(page.getByTestId('monthly-refund-approve')).toHaveCount(0);
    await browserExpect(page.getByTestId('monthly-refund-execute')).toHaveCount(0);
    expect((await calls(page)).map(([name]) => name)).toEqual(['quote', 'approve', 'execute']);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('names the failed refund rule from the server reason code and suggests the right next step', async () => {
  const { page, errors } = await open();
  try {
    const setMode = (mode: string) => page.evaluate(value => {
      (window as unknown as { mode: Record<string, string> }).mode.quote = value; }, mode);
    await fill(page);
    await setMode('code:PAY_REFUND_CREDITS_CONSUMED');
    await page.getByTestId('monthly-refund-quote-button').click();
    await browserExpect(page.getByTestId('monthly-refund-quote-error')).toContainText('拿不到报价：从这次付款起，这个账户用过积分');
    await browserExpect(page.getByTestId('monthly-refund-quote-next')).toContainText('选择“不符合退款条件”拒绝');
    await setMode('code:PAY_REFUND_TICKET_MISMATCH');
    await page.getByTestId('monthly-refund-quote-button').click();
    await browserExpect(page.getByTestId('monthly-refund-quote-error')).toContainText('工单不是这位用户的账单类工单');
    await browserExpect(page.getByTestId('monthly-refund-quote-next')).toContainText('不要直接拒绝');
    await setMode('code:PAY_REFUND_QUOTE_UNAVAILABLE');
    await page.getByTestId('monthly-refund-quote-button').click();
    await browserExpect(page.getByTestId('monthly-refund-quote-error')).toContainText('退款证据不足或状态已变化');
    await browserExpect(page.getByTestId('monthly-refund-quote-next')).toContainText('常见原因');
    await browserExpect(page.getByTestId('monthly-refund-quote-error')).not.toContainText('PAY_');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
