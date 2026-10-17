/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { RateLimitError } from '../lib/rateLimitError';
import { ConnectError } from '../services/publishMonitor/connect';
import { DataError } from '../services/publishMonitor/data';
import { ManualImportError } from '../services/publishMonitor/manualImport';
import { RefreshError } from '../services/publishMonitor/refresh';
import { TikhubConnectionError } from '../services/publishMonitor/tikhub';
import { assertPublishMonitorEnabled, PublishMonitorError } from '../services/publishMonitor/foundation';
import { PostForMeNotConfigured } from '../services/publishMonitor/postForMe/config';
import { PublishError } from '../services/publishMonitor/publish';

/** PUBLISH-MONITOR: every procedure runs only with service-role access and while the admin switch is on. */
type SwitchReader = Parameters<typeof assertPublishMonitorEnabled>[0];
const FORBIDDEN = new Set(['PUBLISH_MONITOR_DISABLED', 'PUBLISH_MONITOR_ACCOUNT_CLOSED',
  'PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE', 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED', 'PUBLISH_MONITOR_WORK_ITEM_MISMATCH',
  'PUBLISH_MONITOR_REFRESH_UNAVAILABLE']);
const CONFLICT = new Set(['PUBLISH_MONITOR_REQUEST_INVALID', 'PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE',
  'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED', 'PUBLISH_MONITOR_AUTHORIZATION_CHANGED', 'PUBLISH_MONITOR_CALLBACK_STALE',
  'PUBLISH_MONITOR_REFRESH_RUNNING', 'PUBLISH_MONITOR_BENCHMARK_EXISTS', 'PUBLISH_MONITOR_BENCHMARK_LIMIT']);

const PUBLISH_FORBIDDEN = new Set(['PUBLISH_MONITOR_TARGET_INVALID', 'PUBLISH_MONITOR_WORK_ITEM_INVALID',
  'PUBLISH_MONITOR_ACCOUNT_CLOSED']);
const PUBLISH_PRECONDITION = new Set(['PUBLISH_MONITOR_QUOTA_EXHAUSTED', 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED',
  'PUBLISH_MONITOR_PRICE_NOT_CONFIGURED', 'PUBLISH_MONITOR_INSUFFICIENT_CREDITS']);

function publishToTrpc(cause: PublishError): TRPCError {
  if (cause.code === 'PUBLISH_MONITOR_PROVIDER_BUSY') return new RateLimitError('rate_limited', cause.retryAfterSeconds ?? 60);
  if (cause.code === 'PUBLISH_MONITOR_TOO_MANY_REJECTIONS') return new RateLimitError('rate_limited', 3600);
  const code = cause.code === 'PUBLISH_MONITOR_JOB_NOT_FOUND' ? 'NOT_FOUND'
    : cause.code === 'PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH' ? 'CONFLICT'
      : PUBLISH_FORBIDDEN.has(cause.code) ? 'FORBIDDEN'
        : PUBLISH_PRECONDITION.has(cause.code) ? 'PRECONDITION_FAILED' : 'INTERNAL_SERVER_ERROR';
  return new TRPCError({ code, message: cause.code, cause });
}

function toTrpc(cause: unknown): TRPCError {
  if (cause instanceof TRPCError) return cause;
  if (cause instanceof PublishError) return publishToTrpc(cause);
  if (cause instanceof ConnectError && cause.code === 'PUBLISH_MONITOR_PROVIDER_BUSY') {
    return new RateLimitError('rate_limited', cause.retryAfterSeconds ?? 60);
  }
  if (cause instanceof DataError && cause.code === 'PUBLISH_MONITOR_REFRESH_TOO_SOON') {
    return new RateLimitError('rate_limited', 3600);
  }
  const code = cause instanceof PublishMonitorError || cause instanceof ConnectError || cause instanceof DataError
    || cause instanceof RefreshError || cause instanceof ManualImportError || cause instanceof TikhubConnectionError
    ? cause.code
    : cause instanceof PostForMeNotConfigured ? 'PUBLISH_MONITOR_PROVIDER_UNAVAILABLE' : 'PUBLISH_MONITOR_UNAVAILABLE';
  if (code === 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' || code === 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND'
    || code === 'PUBLISH_MONITOR_POST_NOT_FOUND') {
    return new TRPCError({ code: 'NOT_FOUND', message: code, cause });
  }
  if (code === 'PUBLISH_MONITOR_PROFILE_LINK_INVALID') return new TRPCError({ code: 'BAD_REQUEST', message: code, cause });
  if (code === 'PUBLISH_MONITOR_IMPORT_INVALID') return new TRPCError({ code: 'BAD_REQUEST', message: code, cause });
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
