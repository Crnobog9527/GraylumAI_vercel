/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DiagnosticContext, DiagnosticTestResult } from '../diagnostics';
import { readStopLoss, usdThreshold } from './stopLossSettings';

export const providerBalanceInput = z.object({
  provider: z.enum(['openrouter', 'tikhub', 'parallel', 'firecrawl', 'brightdata']),
  balanceUsd: usdThreshold,
}).strict();
// This first slice accepts an explicitly labelled administrator observation. It does not
// request management credentials or misrepresent a key's limit as the account balance.
export async function recordProviderBalance(db: SupabaseClient, input: z.infer<typeof providerBalanceInput>) {
  const parsed = providerBalanceInput.parse(input);
  const observedAt = new Date().toISOString();
  const { error } = await db.from('diagnostic_results').insert({
    test_id: `runtime_provider_balance_${parsed.provider}`, test_name: 'Provider balance observation',
    category: 'billing', status: parsed.balanceUsd === null ? 'warning' : 'passed', run_type: 'manual',
    details: { ...parsed, observedAt, source: 'admin_observation' },
  });
  if (error) throw new Error('RUNTIME_STOP_LOSS_UNAVAILABLE');
  return { ...parsed, observedAt, source: 'admin_observation' as const };
}
const scaled = (s: string) => {
  const [whole, fraction = ''] = s.split('.');
  return BigInt(whole!) * 10n ** 12n + BigInt(fraction.padEnd(12, '0'));
};
export async function inspectProviderBalances(db: SupabaseClient, threshold: string, now = new Date()) {
  const providers = providerBalanceInput.shape.provider.options;
  const observations = [];
  for (const provider of providers) {
    const { data, error } = await db.from('diagnostic_results').select('details,created_at')
      .eq('test_id', `runtime_provider_balance_${provider}`).order('created_at', { ascending: false }).limit(1);
    if (error) throw new Error('RUNTIME_STOP_LOSS_UNAVAILABLE');
    const row = data?.[0];
    const parsed = providerBalanceInput.safeParse(row?.details && { provider, balanceUsd: row.details.balanceUsd });
    const age = row ? now.getTime() - Date.parse(row.created_at) : NaN;
    const balance = parsed.success && Number.isFinite(age) && age >= 0 && age < 86400000 ? parsed.data.balanceUsd : null;
    const status = balance === null ? 'unknown' : scaled(balance) <= scaled(threshold) ? 'low' : 'ok';
    observations.push({ provider, status, balanceUsd: balance, observedAt: row?.created_at ?? null, source: 'admin_observation' });
    if (status !== 'ok') {
      const { error: saveError } = await db.rpc('runtime_stop_loss_alert', {
        k: `runtime_stop_loss_balance_${provider}_${status}`,
        d: { dedupeKey: `${now.toISOString().slice(0, 10)}:${provider}:${status}:${threshold}`,
          provider, status, balanceUsd: balance, thresholdUsd: threshold, source: 'admin_observation' },
      });
      if (saveError) throw new Error('RUNTIME_STOP_LOSS_UNAVAILABLE');
    }
  }
  return observations;
}
export async function testRuntimeStopLoss(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const start = Date.now();
  const base = { testId: 'runtime_stop_loss', testName: 'Runtime 成本与余额告警', category: 'billing' as const };
  try {
    const { config } = await readStopLoss(ctx.supabaseAdmin);
    const { data, error } = await ctx.supabaseAdmin.rpc('runtime_stop_loss_observe', { a: null });
    if (error) throw new Error('unavailable');
    const balances = config.providerBalanceAlertUsd === null ? []
      : await inspectProviderBalances(ctx.supabaseAdmin, config.providerBalanceAlertUsd);
    const siteUsd = String(data?.siteUsd ?? '');
    const warning = balances.some(v => v.status !== 'ok') || [config.siteDailyUsd, config.siteAlertUsd]
      .some(limit => limit !== null && scaled(siteUsd) >= scaled(limit));
    return { ...base, status: warning ? 'warning' : 'passed', latencyMs: Date.now() - start,
      message: warning ? '成本已达阈值，或供应商余额偏低/未知；详情见止损告警。' : '成本检查已完成，外部通知尚未连接。',
      details: { usage: data, balances, externalNotifications: 'not_connected' } };
  } catch {
    return { ...base, status: 'error', latencyMs: Date.now() - start, message: 'RUNTIME_STOP_LOSS_MONITOR_UNAVAILABLE' };
  }
}
