/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isProductionSite } from '../notify/config';

type Env = Record<string, string | undefined>;

/*
 * ALERT-FEISHU: both variables are optional. Unset means no alert is sent (previews, local runs, CI). The URL is checked
 * here, where it is used, rather than in envValidator, so a mistyped value turns alerts off instead of failing the site.
 * Neither value is ever logged: the URL carries the bot's token.
 */
export type FeishuConfig = { webhookUrl: string; secret: string };
export type ConfigCheck = { config: FeishuConfig | null; problem: string | null };

const WEBHOOK = /^https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,128}$/;
const PRODUCTION_ORIGIN = 'https://www.graylum.com';

export function feishuConfig(env: Env): ConfigCheck {
  const url = env.FEISHU_ALERT_WEBHOOK_URL?.trim();
  const secret = env.FEISHU_ALERT_SECRET?.trim();
  if (!url && !secret) return { config: null, problem: null };
  if (!url || !secret) return { config: null, problem: 'OWNER_ALERT_CONFIG_INCOMPLETE' };
  if (!WEBHOOK.test(url)) return { config: null, problem: 'OWNER_ALERT_WEBHOOK_INVALID' };
  return { config: { webhookUrl: url, secret }, problem: null };
}

/** Where the admin links point: this deployment's site, so a staging alert opens the staging admin. */
export function alertOrigin(env: Env): string {
  try {
    const url = new URL(env.NEXT_PUBLIC_APP_URL ?? '');
    if (url.protocol === 'https:' || url.hostname === 'localhost') return url.origin;
  } catch { /* fall through */ }
  return isProductionSite(env) ? PRODUCTION_ORIGIN : '';
}

/** Anything but the approved production site is marked, so a test alert is never taken for a real one. */
export function isTestSite(env: Env): boolean {
  return !isProductionSite(env);
}
