/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHmac } from 'node:crypto';
import type { FeishuConfig } from './config';

/*
 * ALERT-FEISHU (Owner 2026-11-07): the Feishu group custom bot (open.feishu.cn「自定义机器人使用指南」). POST JSON to the
 * webhook. With 签名校验 on, the body carries `timestamp` (Unix seconds, within an hour of Feishu's clock) and
 * `sign` = Base64(HmacSHA256(key = `${timestamp}\n${secret}`, message = empty)). Feishu answers HTTP 200 even when it
 * refuses; the body's `code` is 0 only on success (19021 bad signature or clock, 11232 rate limited, 9499 bad request).
 * Same shape as Shotviva T72 (core/alerts/feishu.ts).
 */
export const FEISHU_TIMEOUT_MS = 3_000;

export function feishuSign(timestampSeconds: number, secret: string): string {
  return createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64');
}

export function feishuBody(text: string, secret: string, nowMs: number) {
  const timestamp = Math.floor(nowMs / 1000);
  return { timestamp: String(timestamp), sign: feishuSign(timestamp, secret), msg_type: 'text', content: { text } };
}

/** Never carries the URL: it holds the bot's token. */
export class FeishuError extends Error {
  override readonly name = 'FeishuError';
  constructor(readonly code: string) {
    super(code);
  }
}

export type FeishuDeps = { fetch: typeof fetch; now: () => number };

export async function sendFeishu(config: FeishuConfig, text: string, deps: FeishuDeps): Promise<void> {
  let response: Response;
  try {
    response = await deps.fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feishuBody(text, config.secret, deps.now())),
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS),
    });
  } catch {
    throw new FeishuError('FEISHU_REQUEST_FAILED');
  }
  if (!response.ok) throw new FeishuError(`FEISHU_HTTP_${response.status}`);
  let answer: { code?: unknown } | null = null;
  try { answer = await response.json() as { code?: unknown } | null; } catch { /* not JSON: refused below */ }
  if (!answer || typeof answer.code !== 'number') throw new FeishuError('FEISHU_UNEXPECTED_BODY');
  if (answer.code !== 0) throw new FeishuError(`FEISHU_REFUSED_${answer.code}`);
}
