/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for the runtime stop-loss admin card. Amounts stay decimal strings end to end:
// the server compares them with 12 fractional digits, so the page never rounds through floats.

/** Same shape the server accepts (packages/api stopLossSettings usdThreshold). */
export const USD_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,12})?$/;

export const PROVIDERS = [
  ['openrouter', 'OpenRouter'],
  ['tikhub', 'TikHub'],
  ['parallel', 'Parallel'],
  ['firecrawl', 'Firecrawl'],
  ['brightdata', 'Bright Data'],
] as const;
export type Provider = typeof PROVIDERS[number][0];

export function providerLabel(provider: unknown) {
  return PROVIDERS.find(([key]) => key === provider)?.[1] ?? '未知供应商';
}

/** Empty input means "not set" (null); anything else must be a valid amount string. */
export function parseUsdInput(raw: string): { ok: true; value: string | null } | { ok: false } {
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };
  return USD_PATTERN.test(value) ? { ok: true, value } : { ok: false };
}

const SCALE = 12;
function scaled(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole || '0') * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0').slice(0, SCALE) || '0');
}

/** True when `actual` has reached `limit`; both must be non-negative decimal strings. */
export function reachedLimit(actual: string, limit: string) {
  try { return scaled(actual) >= scaled(limit); } catch { return false; }
}

/**
 * Display an amount with at most 4 decimals, truncated (never rounded up), as $X.
 * A nonzero amount below $0.0001 shows as "<$0.0001", never as the special zero limit.
 */
export function formatUsd(value: unknown) {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return '—';
  const [whole, fraction = ''] = value.split('.');
  const cut = fraction.slice(0, 4).replace(/0+$/, '');
  if (/^0+$/.test(whole!) && !cut && /[1-9]/.test(fraction)) return '<$0.0001';
  return `$${whole}${cut ? `.${cut}` : ''}`;
}

export function formatTime(value: unknown) {
  if (typeof value !== 'string') return '—';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString('zh-CN', { hour12: false });
}

type ErrorLike = { message?: unknown; data?: { code?: unknown; httpStatus?: unknown } | null } | null | undefined;

/** Friendly Chinese text for any tRPC failure; raw server text is never shown. */
export function stopLossErrorMessage(error: ErrorLike, action: 'read' | 'save') {
  const code = error?.data?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === 'CONFLICT' || error?.data?.httpStatus === 409) {
    return '设置已被其他人修改。请点“重新读取”查看最新设置，再决定是否重新保存。';
  }
  if (code === 'UNAUTHORIZED') return '登录已过期，请重新登录后再试。';
  if (code === 'FORBIDDEN') return '只有管理员可以查看和修改成本止损设置。';
  if (message === 'RUNTIME_STOP_LOSS_CONFIG_INVALID') {
    return '已保存的止损设置格式异常，新的模型调用会被拒绝。请重新填写并保存一次。';
  }
  if (code === 'BAD_REQUEST') return '填写的内容不符合要求，请检查金额格式后再试。';
  return action === 'read' ? '暂时无法读取成本止损信息，请稍后点“重新读取”。'
    : '保存没有确认成功。请点“重新读取”核对当前设置后再试。';
}

export type StopLossAlert = { id: string; test_id: string; created_at: string; details: unknown };

function detail(details: unknown, key: string) {
  return details && typeof details === 'object' ? (details as Record<string, unknown>)[key] : undefined;
}

/**
 * Describes one stop-loss alert from aggregate fields only. Details are read field by field,
 * never rendered wholesale, so nothing besides amounts, dates and providers reaches the page.
 */
export function describeAlert(alert: StopLossAlert) {
  const d = alert.details;
  const actual = formatUsd(detail(d, 'actualUsd'));
  const threshold = formatUsd(detail(d, 'thresholdUsd'));
  const day = typeof detail(d, 'utcDate') === 'string' ? `${String(detail(d, 'utcDate'))}（UTC）` : null;
  const id = alert.test_id;
  if (id === 'runtime_stop_loss_siteDailyUsd') {
    return { title: '全站每日上限已达到', detail: `当天实际 ${actual}，上限 ${threshold}`, day };
  }
  if (id === 'runtime_stop_loss_siteAlertUsd') {
    return { title: '全站成本提醒线已达到', detail: `当天实际 ${actual}，提醒线 ${threshold}`, day };
  }
  if (id === 'runtime_stop_loss_userDailyUsd') {
    return { title: '有用户达到每人每日上限', detail: `上限 ${threshold}（只记汇总，不记录是哪位用户）`, day };
  }
  if (id === 'runtime_stop_loss_monitor_unavailable') {
    return { title: '止损检查暂时无法读取设置', detail: '这期间新的计费调用会被拒绝，请检查并重新保存止损设置。', day: null };
  }
  const balance = /^runtime_stop_loss_balance_([a-z]+)_(low|unknown)$/.exec(id);
  if (balance) {
    const name = providerLabel(balance[1]);
    return balance[2] === 'low'
      ? { title: `${name} 余额偏低`, detail: `记录余额 ${formatUsd(detail(d, 'balanceUsd'))}，提醒线 ${threshold}`, day: null }
      : { title: `${name} 余额未知`, detail: `24 小时内没有有效的余额记录，提醒线 ${threshold}`, day: null };
  }
  return { title: '其他止损告警', detail: '', day: null };
}
