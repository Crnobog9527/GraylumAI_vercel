/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logger } from '../lib/logger';

export const CREDIT_BALANCE_UNAVAILABLE_MESSAGE = '余额暂时无法验证，请稍后重试';

export type CreditBalanceFailureReason =
  | 'profile_missing'
  | 'permission_denied'
  | 'timeout'
  | 'network'
  | 'database'
  | 'invalid_balance';

export class CreditBalanceUnavailableError extends Error {
  constructor(public readonly reason: CreditBalanceFailureReason, cause?: unknown,
    public readonly diagnostics?: { code?: string; attempts: number; elapsedMs: number }) {
    super(CREDIT_BALANCE_UNAVAILABLE_MESSAGE, { cause });
    this.name = 'CreditBalanceUnavailableError';
  }
}

export type CreditBalanceReadOptions = { recoverTransient?: boolean };

// Only structured, allowlisted codes enter logs; raw messages/details can contain
// credentials or SQL/user data. Preserve the difference between SQL cancellation,
// pool acquisition timeout, transport failure and our own bounded deadline.
export function creditBalanceDiagnostics(error: unknown) {
  const original = error instanceof CreditBalanceUnavailableError ? error.cause : error;
  const code = error instanceof CreditBalanceUnavailableError && error.diagnostics?.code
    || getErrorField(original, 'code').toUpperCase();
  return { reason: classifyCreditBalanceFailure(error),
    ...(/^(?:[0-9A-Z]{5}|PGRST\d{3}|CLIENT_TIMEOUT)$/.test(code) ? {code} : {}),
    ...(error instanceof CreditBalanceUnavailableError && error.diagnostics
      ? {attempts:error.diagnostics.attempts,elapsedMs:error.diagnostics.elapsedMs} : {}) };
}

function getErrorField(error: unknown, field: 'code' | 'message'): string {
  if (!error || typeof error !== 'object' || !(field in error)) {
    return '';
  }

  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

export function classifyCreditBalanceFailure(error: unknown): CreditBalanceFailureReason {
  if (error instanceof CreditBalanceUnavailableError) {
    return error.reason;
  }

  const code = getErrorField(error, 'code').toUpperCase();
  const message = getErrorField(error, 'message').toLowerCase();

  if (code === 'PGRST116') {
    return 'profile_missing';
  }
  if (code === '42501' || code === 'PGRST301' || message.includes('permission') || message.includes('row-level security')) {
    return 'permission_denied';
  }
  if (code === '57014' || code === 'PGRST003' || message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  if (error instanceof TypeError || message.includes('network') || message.includes('fetch failed')) {
    return 'network';
  }

  return 'database';
}

export function normalizeCreditBalance(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
  ) {
    throw new CreditBalanceUnavailableError('invalid_balance');
  }

  return value;
}

async function readOnce(supabase: any, profileId: string, signal?: AbortSignal): Promise<number> {
  try {
    const query = supabase
      .from('profiles')
      .select('credits')
      .eq('id', profileId);
    const { data: profile, error, status } = await (signal ? query.abortSignal(signal).retry(false) : query).single();

    if (error) {
      const reason=classifyCreditBalanceFailure(error);
      // Retain the SDK's transient 503/520 recovery, but within our GET budget.
      // Structured terminal errors (notably auth/ACL) always take precedence.
      throw new CreditBalanceUnavailableError(signal && reason==='database' && [503,520].includes(status) ? 'network' : reason, error);
    }
    if (!profile) {
      throw new CreditBalanceUnavailableError('profile_missing');
    }

    return normalizeCreditBalance(profile.credits);
  } catch (error) {
    if (error instanceof CreditBalanceUnavailableError) {
      throw error;
    }

    throw new CreditBalanceUnavailableError(classifyCreditBalanceFailure(error), error);
  }
}

export async function readCreditBalance(supabase: any, profileId: string, options: CreditBalanceReadOptions = {}): Promise<number> {
  // Opted-in chat reads get at most two fresh GETs. No cache, role/client switch,
  // write/RPC retry, model dispatch or request-ID change is possible here.
  if (!options.recoverTransient) return readOnce(supabase, profileId);
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new CreditBalanceUnavailableError('timeout', undefined,
            {code:'CLIENT_TIMEOUT',attempts:attempt,elapsedMs:Date.now()-started}));
          controller.abort();
        }, 3000);
      });
      return await Promise.race([readOnce(supabase, profileId, controller.signal), deadline]);
    } catch (error) {
      const diagnostic = creditBalanceDiagnostics(error);
      const details = {...diagnostic,attempts:attempt,elapsedMs:Date.now()-started};
      if (attempt === 2 || !['timeout','network'].includes(diagnostic.reason)) {
        throw new CreditBalanceUnavailableError(diagnostic.reason, error, details);
      }
      logger.warn('billing', 'billing_balance_read_retry', details);
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new CreditBalanceUnavailableError('database'); // exhaustive safety guard
}
