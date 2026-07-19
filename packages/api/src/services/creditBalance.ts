export const CREDIT_BALANCE_UNAVAILABLE_MESSAGE = '余额暂时无法验证，请稍后重试';

export type CreditBalanceFailureReason =
  | 'profile_missing'
  | 'permission_denied'
  | 'timeout'
  | 'network'
  | 'database'
  | 'invalid_balance';

export class CreditBalanceUnavailableError extends Error {
  constructor(public readonly reason: CreditBalanceFailureReason, cause?: unknown) {
    super(CREDIT_BALANCE_UNAVAILABLE_MESSAGE, { cause });
    this.name = 'CreditBalanceUnavailableError';
  }
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

export async function readCreditBalance(supabase: any, profileId: string): Promise<number> {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', profileId)
      .single();

    if (error) {
      throw new CreditBalanceUnavailableError(classifyCreditBalanceFailure(error), error);
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
