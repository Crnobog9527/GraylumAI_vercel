/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logger } from '../../lib/logger';
import { alertOrigin, feishuConfig, isTestSite, type FeishuConfig } from './config';
import { createDedupe, redisMarkStore, type Dedupe } from './dedupe';
import { FeishuError, sendFeishu, type FeishuDeps } from './feishu';
import { dedupeKey, ttlSeconds, type OwnerAlertFacts, type OwnerAlertKind } from './kinds';
import { renderAlert } from './templates';

/*
 * ALERT-FEISHU (Owner 2026-11-07): notifyOwner(kind, facts) posts the Owner's plain-Chinese business alert to the Graylum
 * Feishu group bot. It never throws and never changes what the caller does: a Feishu outage, a refused signature or a
 * Redis failure is logged (a warning that also reaches Sentry), nothing more. Without FEISHU_ALERT_WEBHOOK_URL and
 * FEISHU_ALERT_SECRET it returns at once, before any Redis or network call (previews, local runs, CI).
 * Sentry keeps collecting errors for developers; this runs beside it. Same flow as Shotviva T72 (core/alerts/notify.ts).
 */
export type NotifyDeps = {
  config: FeishuConfig | null;
  dedupe: Dedupe;
  feishu: FeishuDeps;
  origin: string;
  testSite: boolean;
  now: () => Date;
};

/** Condition alerts whose failed send keeps the cooldown: retrying on every new error would only add load while Feishu is down. */
const KEEP_COOLDOWN_ON_FAILURE: ReadonlySet<OwnerAlertKind> = new Set(['error_spike']);

/** true when a message went out. */
export async function notifyOwnerWith<K extends OwnerAlertKind>(deps: NotifyDeps, kind: K, facts: OwnerAlertFacts[K]): Promise<boolean> {
  if (!deps.config) return false;
  const key = dedupeKey(kind, facts, deps.now());
  if (!(await deps.dedupe.claim(key, ttlSeconds(kind)))) return false;
  try {
    await sendFeishu(deps.config, renderAlert(kind, facts, deps), deps.feishu);
    logger.info('system', 'owner_alert_sent', { kind, key });
    return true;
  } catch (error) {
    if (!KEEP_COOLDOWN_ON_FAILURE.has(kind)) await deps.dedupe.release(key);
    // A warning (never an error), so the error-spike counter does not count its own failures.
    logger.warn('system', 'owner_alert_not_sent', { kind, key, swallowed: true,
      code: error instanceof FeishuError ? error.code : 'OWNER_ALERT_RENDER_FAILED' });
    return false;
  }
}

let defaults: NotifyDeps | undefined;

export function defaultNotifyDeps(env: Record<string, string | undefined> = process.env): NotifyDeps {
  if (defaults) return defaults;
  const { config, problem } = feishuConfig(env);
  // Logged once per instance, by code only: never the values.
  if (problem) logger.warn('system', 'owner_alerts_off', { code: problem, swallowed: true });
  defaults = {
    config,
    dedupe: createDedupe(redisMarkStore),
    feishu: { fetch: (input, init) => fetch(input, init), now: Date.now },
    origin: alertOrigin(env),
    testSite: isTestSite(env),
    now: () => new Date(),
  };
  return defaults;
}

/** Tests only: forget the cached configuration. */
export function resetOwnerAlertDefaults(next?: NotifyDeps) {
  defaults = next;
}

/** Whether alerts are configured here (lets a caller skip work, such as a database read, that only an alert needs). */
export function ownerAlertsEnabled(): boolean {
  try { return defaultNotifyDeps().config !== null; } catch { return false; }
}

/** The admin's test message (diagnostics, run by hand): 'off' when the variables are not set here, else whether it went out. */
export async function sendOwnerAlertTest(): Promise<'sent' | 'off' | 'not_sent'> {
  try {
    const deps = defaultNotifyDeps();
    if (!deps.config) return 'off';
    const note = '这是后台「诊断 → Runtime 成本与余额告警」手动运行时发的测试消息，收到就说明这个环境的两个变量配好了。';
    return await notifyOwnerWith(deps, 'test', { note }) ? 'sent' : 'not_sent';
  } catch {
    return 'not_sent';
  }
}

export async function notifyOwner<K extends OwnerAlertKind>(kind: K, facts: OwnerAlertFacts[K]): Promise<void> {
  try {
    await notifyOwnerWith(defaultNotifyDeps(), kind, facts);
  } catch {
    logger.warn('system', 'owner_alert_crashed', { kind, swallowed: true });
  }
}
