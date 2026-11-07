/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { readAbsorbAlerts } from '../bill2PlatformAlerts';
import { defaultNotifyDeps, notifyOwnerWith, type NotifyDeps } from './notify';

/*
 * ALERT-FEISHU 「平台垫付」: billing_platform_absorb_alert (admin 成本止损) had no delivery at all, only a live admin query.
 * The every-minute runtime-recovery cron calls this; the first instance each UTC hour (a Redis mark) reads the same report
 * the admin reads, and each model and day over its line is sent once (acknowledging it in the admin ends it). No new
 * table, queue or cron; one Redis call a minute when Feishu is configured, nothing when it is not.
 */
export const ABSORB_MESSAGES_PER_RUN = 5;
type Read = typeof readAbsorbAlerts;

export async function checkPlatformAbsorbWith(db: SupabaseClient, deps: NotifyDeps, read: Read = readAbsorbAlerts): Promise<number> {
  if (!deps.config) return 0;
  const now = deps.now();
  if (!(await deps.dedupe.claim(`platform_absorb_check:${now.toISOString().slice(0, 13)}`, 3600))) return 0;
  const report = await read(db, now);
  let sent = 0;
  for (const alert of report.alerts.slice(0, ABSORB_MESSAGES_PER_RUN)) {
    const facts = { model: alert.model, utcDate: alert.utcDate, usd: alert.nominalEquivalentUsd, thresholdUsd: alert.thresholdUsd };
    if (await notifyOwnerWith(deps, 'platform_absorb', facts)) sent += 1;
  }
  return sent;
}

/** Never throws: the cron's own work never depends on it. */
export async function checkPlatformAbsorb(db: SupabaseClient): Promise<void> {
  try {
    await checkPlatformAbsorbWith(db, defaultNotifyDeps());
  } catch {
    logger.warn('system', 'owner_alert_absorb_check_failed', { swallowed: true });
  }
}
