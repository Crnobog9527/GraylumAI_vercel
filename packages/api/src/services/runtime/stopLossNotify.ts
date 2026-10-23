/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { isProductionSite, noticeConfig, normalizeMailbox, type NoticeConfigResult } from '../notify/config';
import { resendTransport, type NoticeTransport } from '../notify/resend';
import { noticeLayout } from '../notify/templates';

/**
 * RUNTIME-PROD slice C: mails new stop-loss alerts to the Owner. The alert rows written by
 * runtime_stop_loss_alert stay the durable record; delivery state is kept on the same row in
 * details.notify, so no table, queue or cron is added. Sending never throws and never touches the
 * stop itself: the database already refused the calls before anything is mailed.
 */
export const STOP_LOSS_NOTICE_TIMEOUT_MS = 5_000;
/** Resend keeps an idempotency key for 24 hours: an alert already attempted that long ago is not retried (it could duplicate). */
export const STOP_LOSS_NOTICE_WINDOW_MS = 24 * 3600_000;
export const STOP_LOSS_NOTICE_MAX_ATTEMPTS = 5;
const BATCH = 50;
const PAGE = 100;
/** Mails per invocation and wall-clock budget for starting another one; the rest go out on the next run. */
export const MAX_MAILS_PER_RUN = 3;
const DELIVERY_BUDGET_MS = 8_000;
const MAX_PAGES = 5;

type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
type Notify = { state: 'sent' | 'pending' | 'failed'; attempts: number; lastErrorCode?: string;
  lastAttemptAt?: string; sentAt?: string; providerMessageId?: string };
type Row = { id: string; test_id: string; details: Record<string, unknown> | null; created_at: string };

export interface StopLossNoticeDeps {
  config?: NoticeConfigResult;
  transport?: NoticeTransport;
  env?: Record<string, string | undefined>;
  now?: Date;
}
export type StopLossNoticeOutcome =
  | { outcome: 'none' | 'sent'; alerts: number }
  | { outcome: 'not_sent'; alerts: number; code: string };

function notifyOf(row: Row): Notify | null {
  const value = row.details?.notify;
  return value && typeof value === 'object' ? value as Notify : null;
}
const text = (d: Row['details'], key: string) => {
  const value = d?.[key];
  return typeof value === 'string' && /^[0-9A-Za-z.:_-]{1,64}$/.test(value) ? value : null;
};
const usd = (value: string | null) => value === null ? '未知' : `$${value}`;
const PROVIDERS: Record<string, string> = {
  openrouter: 'OpenRouter', tikhub: 'TikHub', parallel: 'Parallel', firecrawl: 'Firecrawl', brightdata: 'Bright Data',
};

/** Same wording as the admin list; reads aggregate fields one by one, never the whole details object. */
export function describeStopLossAlert(row: Pick<Row, 'test_id' | 'details'>) {
  const d = row.details;
  const day = text(d, 'utcDate');
  const when = day ? `（统计日 ${day} UTC）` : '';
  switch (row.test_id) {
    case 'runtime_stop_loss_siteDailyUsd':
      return `全站每日上限已达到，新的计费调用已被拒绝：当天实际 ${usd(text(d, 'actualUsd'))}，上限 ${usd(text(d, 'thresholdUsd'))}${when}`;
    case 'runtime_stop_loss_siteAlertUsd':
      return `全站成本提醒线已达到：当天实际 ${usd(text(d, 'actualUsd'))}，提醒线 ${usd(text(d, 'thresholdUsd'))}${when}`;
    case 'runtime_stop_loss_userDailyUsd':
      return `有用户达到每人每日上限 ${usd(text(d, 'thresholdUsd'))}（只记汇总，不记录是哪位用户）${when}`;
    case 'runtime_stop_loss_monitor_unavailable':
      return '止损检查暂时无法读取设置，这期间新的计费调用会被拒绝，请检查并重新保存止损设置。';
    default: {
      const balance = /^runtime_stop_loss_balance_([a-z]+)_(low|unknown)$/.exec(row.test_id);
      if (!balance) return '其他止损告警，请到后台查看。';
      const name = PROVIDERS[balance[1]!] ?? balance[1];
      return balance[2] === 'low'
        ? `${name} 余额偏低：记录余额 ${usd(text(d, 'balanceUsd'))}，提醒线 ${usd(text(d, 'thresholdUsd'))}`
        : `${name} 余额未知：24 小时内没有有效的余额记录，提醒线 ${usd(text(d, 'thresholdUsd'))}`;
    }
  }
}

export function stopLossNotice(rows: Row[], production: boolean) {
  const env = production ? '' : '[staging] ';
  return noticeLayout(`${env}Graylum 止损告警 / Stop-loss alert`, [
    `有 ${rows.length} 条新的成本止损告警${production ? '' : '（来自测试站 staging）'}：`,
    rows.map((row, i) => `${i + 1}. ${describeStopLossAlert(row)}（记录于 ${row.created_at.slice(0, 19).replace('T', ' ')} UTC）`)
      .join('\n'),
    '处理入口：后台 → 系统设置 → 成本止损。要立刻停止所有新调用，可在那里打开"停止新调用"。',
    'New runtime stop-loss alerts were recorded. Details are in the admin settings, tab 成本止损.',
  ]);
}

async function ownerMailbox(db: Db) {
  const { data, error } = await db.from('system_settings').select('value').eq('key', 'support_email').maybeSingle();
  if (error) return null;
  const value = (data as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? normalizeMailbox(value) : null;
}

async function mark(db: Db, rows: Row[], notify: (row: Row) => Notify) {
  let failed = 0;
  for (const row of rows) {
    const { error } = await db.from('diagnostic_results')
      .update({ details: { ...(row.details ?? {}), notify: notify(row) } }).eq('id', row.id);
    if (error) failed += 1;
  }
  if (failed) logger.error('billing', 'runtime_stop_loss_notice_mark_failed', { rows: failed });
}

const isPending = (row: Row, now: Date) => {
  const n = notifyOf(row);
  if (!n) return true;
  if (n.state !== 'pending' || n.attempts >= STOP_LOSS_NOTICE_MAX_ATTEMPTS) return false;
  // Never sent (blocked by configuration) stays retryable at any age; an ambiguous earlier request only inside Resend's window.
  return n.attempts === 0 || now.getTime() - Date.parse(row.created_at) < STOP_LOSS_NOTICE_WINDOW_MS;
};

/** Pages past delivered/given-up rows (newest first) so terminal alerts cannot starve undelivered ones. */
async function readPending(db: Db, now: Date) {
  const pending: Row[] = [];
  for (let page = 0; page < MAX_PAGES && pending.length < BATCH; page += 1) {
    const { data, error } = await db.from('diagnostic_results').select('id,test_id,details,created_at')
      .eq('test_name', 'Runtime stop-loss').like('test_id', 'runtime_stop_loss_%')
      .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error('read');
    const rows = (data ?? []) as Row[];
    pending.push(...rows.filter(row => isPending(row, now)));
    if (rows.length < PAGE) break;
  }
  return pending.slice(0, BATCH);
}

/**
 * Mails every alert that has not been delivered, one mail per alert. The Resend
 * idempotency key is the alert id plus a hash of the whole envelope, so a retry repeats the same request and a
 * delivered alert is never mailed again. At most MAX_MAILS_PER_RUN per run, inside a time budget.
 * Recipient: support_email in system
 * settings; outside production only PAYMENT_NOTICE_TEST_RECIPIENTS (same guard as payment notices).
 */
export async function deliverStopLossAlerts(db: Db, deps: StopLossNoticeDeps = {}): Promise<StopLossNoticeOutcome> {
  const now = deps.now ?? new Date();
  let pending: Row[] = [];
  try {
    pending = await readPending(db, now);
    if (pending.length === 0) return { outcome: 'none', alerts: 0 };
    const env = deps.env ?? process.env;
    const config = deps.config ?? await noticeConfig(db, env);
    const to = await ownerMailbox(db);
    const refusal = !config.ok ? config.code : !to ? 'STOP_LOSS_NOTICE_NO_MAILBOX'
      : config.config.allowedRecipients && !config.config.allowedRecipients.has(to)
        ? 'STOP_LOSS_NOTICE_RECIPIENT_NOT_ALLOWED' : null;
    if (refusal || !config.ok || !to) {
      const code = refusal ?? 'STOP_LOSS_NOTICE_UNAVAILABLE';
      // Configuration problems do not use up attempts: the mail goes out once the setting is fixed.
      const changed = pending.filter(row => notifyOf(row)?.lastErrorCode !== code);
      if (changed.length) {
        logger.error('billing', 'runtime_stop_loss_notice_not_configured', { code, alerts: pending.length });
        await mark(db, changed, row => ({ ...notifyOf(row), state: 'pending', attempts: notifyOf(row)?.attempts ?? 0,
          lastErrorCode: code }));
      }
      return { outcome: 'not_sent', alerts: pending.length, code };
    }
    const transport = deps.transport ?? resendTransport(fetch, STOP_LOSS_NOTICE_TIMEOUT_MS);
    const at = now.toISOString();
    const startedAt = Date.now();
    let sent = 0;
    let failure: string | null = null;
    let tried = 0;
    for (const row of pending) {
      if (tried >= MAX_MAILS_PER_RUN || Date.now() - startedAt > DELIVERY_BUDGET_MS) break;
      tried += 1;
      const mail = { ...stopLossNotice([row], isProductionSite(env)), from: config.config.from, to,
        replyTo: config.config.replyTo };
      // The key covers the whole envelope: the same request is repeated byte for byte, and a changed recipient,
      // sender or template becomes a new request instead of a permanent Resend idempotency conflict.
      const envelope = createHash('sha256').update(JSON.stringify([mail.to, mail.from, mail.replyTo, mail.subject,
        mail.text, mail.html])).digest('hex').slice(0, 16);
      const idempotencyKey = `runtime-stop-loss-${row.id}-${envelope}`;
      const result = await transport(config.config.apiKey, { ...mail, idempotencyKey });
      if (result.kind === 'sent') {
        sent += 1;
        await mark(db, [row], r => ({ state: 'sent', attempts: (notifyOf(r)?.attempts ?? 0) + 1, sentAt: at,
          providerMessageId: result.providerMessageId }));
        continue;
      }
      failure ??= result.code;
      await mark(db, [row], r => {
        const attempts = (notifyOf(r)?.attempts ?? 0) + 1;
        const final = result.kind === 'conflict' || attempts >= STOP_LOSS_NOTICE_MAX_ATTEMPTS;
        return { state: final ? 'failed' : 'pending', attempts, lastErrorCode: result.code, lastAttemptAt: at };
      });
      logger.error('billing', 'runtime_stop_loss_notice_failed', { code: result.code });
    }
    if (sent) logger.info('billing', 'runtime_stop_loss_notice_sent', { alerts: sent });
    return failure ? { outcome: 'not_sent', alerts: pending.length, code: failure } : { outcome: 'sent', alerts: sent };
  } catch {
    logger.error('billing', 'runtime_stop_loss_notice_unavailable', { alerts: pending.length });
    return { outcome: 'not_sent', alerts: pending.length, code: 'STOP_LOSS_NOTICE_UNAVAILABLE' };
  }
}
