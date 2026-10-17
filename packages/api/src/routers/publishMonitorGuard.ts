/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { RateLimitError } from '../lib/rateLimitError';
import { ConnectError } from '../services/publishMonitor/connect';
import { DataError } from '../services/publishMonitor/data';
import { RefreshError } from '../services/publishMonitor/refresh';
import { assertPublishMonitorEnabled, PublishMonitorError } from '../services/publishMonitor/foundation';
import { PostForMeNotConfigured } from '../services/publishMonitor/postForMe/config';

/** PUBLISH-MONITOR: every procedure runs only with service-role access and while the admin switch is on. */
type SwitchReader = Parameters<typeof assertPublishMonitorEnabled>[0];
const FORBIDDEN = new Set(['PUBLISH_MONITOR_DISABLED', 'PUBLISH_MONITOR_ACCOUNT_CLOSED',
  'PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE', 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED', 'PUBLISH_MONITOR_WORK_ITEM_MISMATCH',
  'PUBLISH_MONITOR_REFRESH_UNAVAILABLE']);
const CONFLICT = new Set(['PUBLISH_MONITOR_REQUEST_INVALID', 'PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE',
  'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED', 'PUBLISH_MONITOR_AUTHORIZATION_CHANGED', 'PUBLISH_MONITOR_CALLBACK_STALE',
  'PUBLISH_MONITOR_REFRESH_RUNNING']);

function toTrpc(cause: unknown): TRPCError {
  if (cause instanceof TRPCError) return cause;
  if (cause instanceof ConnectError && cause.code === 'PUBLISH_MONITOR_PROVIDER_BUSY') {
    return new RateLimitError('rate_limited', cause.retryAfterSeconds ?? 60);
  }
  if (cause instanceof DataError && cause.code === 'PUBLISH_MONITOR_REFRESH_TOO_SOON') {
    return new RateLimitError('rate_limited', 3600);
  }
  const code = cause instanceof PublishMonitorError || cause instanceof ConnectError || cause instanceof DataError
    || cause instanceof RefreshError ? cause.code
    : cause instanceof PostForMeNotConfigured ? 'PUBLISH_MONITOR_PROVIDER_UNAVAILABLE' : 'PUBLISH_MONITOR_UNAVAILABLE';
  if (code === 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' || code === 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND'
    || code === 'PUBLISH_MONITOR_POST_NOT_FOUND') {
    return new TRPCError({ code: 'NOT_FOUND', message: code, cause });
  }
  if (code === 'PUBLISH_MONITOR_PLATFORM_UNSUPPORTED') return new TRPCError({ code: 'BAD_REQUEST', message: code, cause });
  if (FORBIDDEN.has(code)) return new TRPCError({ code: 'FORBIDDEN', message: code, cause });
  if (CONFLICT.has(code)) return new TRPCError({ code: 'CONFLICT', message: code, cause });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: code, cause });
}

export async function guarded<T>(ctx: { hasSupabaseAdminPrivileges: boolean; supabaseAdmin: SwitchReader },
  work: () => Promise<T>, requireSwitch = true): Promise<T> {
  if (!ctx.hasSupabaseAdminPrivileges) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'PUBLISH_MONITOR_UNAVAILABLE' });
  }
  try {
    if (requireSwitch) await assertPublishMonitorEnabled(ctx.supabaseAdmin);
    return await work();
  } catch (cause) {
    throw toTrpc(cause);
  }
}
