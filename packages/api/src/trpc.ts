import { initTRPC, TRPCError } from '@trpc/server';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { getAuthProvider, isEmailVerified } from './lib/auth';
import { ensureWorkspaceServerEnv } from './lib/serverEnv';
import { logger } from './lib/logger';

type ApiSupabaseClient = SupabaseClient<any, 'public', any>;
type ApiContext = Awaited<ReturnType<typeof createTRPCContext>>;
type ProfileBootstrapFailureReason =
  | 'profile_create_failed'
  | 'opening_grant_failed'
  | 'service_role_unavailable';

const PROFILE_SELECT = 'id, role, credits, status, nickname, email, membership_level, created_at';
const PROFILE_BOOTSTRAP_RECOVERY_CUTOFF_MS = Date.parse('2026-06-25T00:00:00.000Z');

function deriveProfileNickname(user: User): string {
  const metadata = user.user_metadata ?? {};
  const candidates = [
    metadata.nickname,
    metadata.display_name,
    metadata.full_name,
    metadata.name,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 80);
    }
  }

  const emailPrefix = user.email?.split('@')[0]?.trim();
  if (emailPrefix) {
    return emailPrefix.slice(0, 80);
  }

  return `user-${user.id.slice(0, 8)}`;
}

export const createTRPCContext = async (opts: {
  headers: Headers;
  user?: User | null;
  supabaseAuth?: ApiSupabaseClient | null;
}) => {
  ensureWorkspaceServerEnv();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const hasSupabaseAdminPrivileges = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabasePublic = createClient(supabaseUrl, supabaseAnonKey);
  const supabaseAdmin = hasSupabaseAdminPrivileges
    ? createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

  let user = opts.user ?? null;
  let supabaseAuth = opts.supabaseAuth ?? null;

  if (!supabaseAuth && !user) {
    // Get token from Authorization header
    const authHeader = opts.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '');

    if (token) {
      supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      });

      const { data: { user: authUser }, error } = await supabaseAuth.auth.getUser(token);
      if (!error && authUser) {
        user = authUser;
      }
    }
  }

  if (!user && supabaseAuth) {
    const { data: { user: authUser }, error } = await supabaseAuth.auth.getUser();
    if (!error && authUser) {
      user = authUser;
    }
  }

  return {
    ...opts,
    supabase: supabaseAuth ?? supabasePublic,
    supabasePublic,
    // Keep the admin writer absent when the service-role credential is absent.
    // Privileged procedures are guarded by hasSupabaseAdminPrivileges.
    supabaseAdmin: supabaseAdmin as ApiSupabaseClient,
    supabaseAuth,
    hasSupabaseAdminPrivileges,
    user,
    authProvider: getAuthProvider(user),
    isEmailVerified: isEmailVerified(user),
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

const OPENING_GRANT_CREDITS = 100;

function getOpeningGrantIdempotencyKey(userId: string) {
  return `opening_grant:${userId}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }

  return String(error);
}

function normalizeUserRole(role: unknown): 'user' | 'admin' {
  return role === 'admin' ? 'admin' : 'user';
}

function normalizeUserStatus(status: unknown): 'active' | 'disabled' | 'banned' {
  if (status === 'disabled' || status === 'banned') {
    return status;
  }

  return 'active';
}

function createProfileBootstrapError(reason: ProfileBootstrapFailureReason) {
  const messageByReason: Record<ProfileBootstrapFailureReason, string> = {
    profile_create_failed: 'profile_bootstrap_failed: 创建用户资料失败，请联系客服',
    opening_grant_failed: 'profile_bootstrap_failed: 初始化用户积分失败，请联系客服',
    service_role_unavailable: 'profile_bootstrap_failed: 服务端资料初始化未配置',
  };

  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: messageByReason[reason],
  });
}

function isRecoverableBootstrapProfile(profile: Record<string, unknown>, normalizedEmail: string | null) {
  const createdAtMs = typeof profile.created_at === 'string'
    ? Date.parse(profile.created_at)
    : NaN;

  return Number.isFinite(createdAtMs)
    && createdAtMs >= PROFILE_BOOTSTRAP_RECOVERY_CUTOFF_MS
    && profile.role === 'user'
    && profile.status === 'active'
    && profile.membership_level === 'free'
    && Number(profile.credits) === 0
    && (!normalizedEmail || profile.email === normalizedEmail);
}

async function applyOpeningGrant(ctx: ApiContext, userId: string) {
  const idempotencyKey = getOpeningGrantIdempotencyKey(userId);
  const { data, error } = await ctx.supabaseAdmin.rpc('atomic_apply_credit_ledger_entry', {
    p_user_id: userId,
    p_amount: OPENING_GRANT_CREDITS,
    p_type: 'addition',
    p_description: 'Opening grant for new user profile bootstrap',
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    throw error;
  }

  const ledgerEntry = data?.[0];
  if (!ledgerEntry) {
    throw new Error('atomic opening grant ledger RPC returned no rows');
  }
}

async function findOpeningGrantLedgerEntry(ctx: ApiContext, userId: string) {
  return ctx.supabaseAdmin
    .from('credit_transactions')
    .select('id, amount, balance_after, idempotency_key')
    .eq('user_id', userId)
    .eq('idempotency_key', getOpeningGrantIdempotencyKey(userId))
    .maybeSingle();
}

async function cleanupSafeBootstrapProfile(ctx: ApiContext, userId: string) {
  return ctx.supabaseAdmin
    .from('profiles')
    .delete()
    .eq('id', userId)
    .eq('role', 'user')
    .eq('status', 'active')
    .eq('membership_level', 'free')
    .eq('credits', 0);
}

async function recoverOpeningGrantForExistingBootstrapProfile(ctx: ApiContext, userId: string) {
  const { data: existingOpeningGrant, error: openingGrantLookupError } =
    await findOpeningGrantLedgerEntry(ctx, userId);

  if (existingOpeningGrant) {
    logger.warn('auth', 'profile_opening_grant_already_recorded', {
      userId,
      idempotencyKey: getOpeningGrantIdempotencyKey(userId),
      recovery: true,
    });
    return;
  }

  if (openingGrantLookupError) {
    logger.error('auth', 'profile_opening_grant_lookup_failed', {
      userId,
      error: getErrorMessage(openingGrantLookupError),
      recovery: true,
    });
    throw createProfileBootstrapError('opening_grant_failed');
  }

  try {
    await applyOpeningGrant(ctx, userId);
  } catch (openingGrantError) {
    logger.error('auth', 'profile_opening_grant_recovery_failed', {
      userId,
      error: getErrorMessage(openingGrantError),
    });

    const { data: recoveredOpeningGrant, error: recoveryLookupError } =
      await findOpeningGrantLedgerEntry(ctx, userId);

    if (recoveredOpeningGrant) {
      logger.warn('auth', 'profile_opening_grant_already_recorded', {
        userId,
        idempotencyKey: getOpeningGrantIdempotencyKey(userId),
        recovery: true,
      });
      return;
    }

    if (recoveryLookupError) {
      logger.error('auth', 'profile_opening_grant_lookup_failed', {
        userId,
        error: getErrorMessage(recoveryLookupError),
        recovery: true,
      });
    }

    throw createProfileBootstrapError('opening_grant_failed');
  }
}

async function recoverOpeningGrantIfRecoverableBootstrapProfile(
  ctx: ApiContext,
  userId: string,
  profile: Record<string, unknown>,
  normalizedEmail: string | null,
) {
  if (ctx.hasSupabaseAdminPrivileges && isRecoverableBootstrapProfile(profile, normalizedEmail)) {
    await recoverOpeningGrantForExistingBootstrapProfile(ctx, userId);
  }
}

async function fetchProfileById(client: ApiSupabaseClient, userId: string) {
  return client
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', userId)
    .single();
}

async function ensureProfile(ctx: ApiContext) {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }

  const userScopedSupabase = ctx.supabaseAuth ?? ctx.supabase;
  const userId = ctx.user.id;
  const derivedNickname = deriveProfileNickname(ctx.user);
  const normalizedEmail = ctx.user.email ?? null;

  let { data: profile, error: profileError } = await fetchProfileById(userScopedSupabase, userId);

  if (!profile && profileError?.code !== 'PGRST116' && ctx.hasSupabaseAdminPrivileges) {
    logger.warn('auth', 'profile_user_scoped_lookup_failed_using_service_role', {
      code: profileError?.code ?? null,
    });

    const adminLookup = await fetchProfileById(ctx.supabaseAdmin, userId);
    profile = adminLookup.data;
    profileError = adminLookup.error;
  }

  if (profile && !profileError) {
    await recoverOpeningGrantIfRecoverableBootstrapProfile(ctx, userId, profile, normalizedEmail);

    const shouldBackfillNickname = !profile.nickname?.trim();
    const shouldSyncEmail = normalizedEmail && profile.email !== normalizedEmail;

    if (shouldBackfillNickname || shouldSyncEmail) {
      await userScopedSupabase
        .from('profiles')
        .update({
          ...(shouldBackfillNickname ? { nickname: derivedNickname } : {}),
          ...(shouldSyncEmail ? { email: normalizedEmail } : {}),
        })
        .eq('id', userId);
    }

    return {
      profileId: profile.id,
      userRole: normalizeUserRole(profile.role),
      userStatus: normalizeUserStatus(profile.status),
      userScopedSupabase,
    };
  }

  const isNotFound = profileError?.code === 'PGRST116';

  if (!isNotFound) {
    logger.error('auth', 'profile_query_failed', {
      code: profileError?.code ?? null,
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取用户资料失败，请稍后重试',
    });
  }

  if (!ctx.hasSupabaseAdminPrivileges) {
    logger.error('auth', 'profile_bootstrap_service_role_unavailable');
    throw createProfileBootstrapError('service_role_unavailable');
  }

  const { data: newProfile, error: createError } = await ctx.supabaseAdmin
    .from('profiles')
    .insert({
      id: userId,
      email: normalizedEmail,
      nickname: derivedNickname,
      role: 'user',
      status: 'active',
      membership_level: 'free',
      credits: 0,
    })
    .select(PROFILE_SELECT)
    .single();

  if (createError) {
    logger.error('auth', 'profile_create_failed', {
      code: createError.code,
      conflict: createError.code === '23505',
    });

    if (createError.code === '23505') {
      const { data: existingProfile } = await fetchProfileById(ctx.supabaseAdmin, userId);

      if (existingProfile) {
        await recoverOpeningGrantIfRecoverableBootstrapProfile(ctx, userId, existingProfile, normalizedEmail);

        return {
          profileId: existingProfile.id,
          userRole: normalizeUserRole(existingProfile.role),
          userStatus: normalizeUserStatus(existingProfile.status),
          userScopedSupabase,
        };
      }
    }

    throw createProfileBootstrapError('profile_create_failed');
  }

  if (!newProfile) {
    logger.error('auth', 'profile_create_returned_no_rows');
    throw createProfileBootstrapError('profile_create_failed');
  }

  try {
    await applyOpeningGrant(ctx, userId);
  } catch (openingGrantError) {
    logger.error('auth', 'profile_opening_grant_failed', {
      userId,
      error: getErrorMessage(openingGrantError),
    });

    const { data: existingOpeningGrant, error: openingGrantLookupError } =
      await findOpeningGrantLedgerEntry(ctx, userId);

    if (existingOpeningGrant) {
      logger.warn('auth', 'profile_opening_grant_already_recorded', {
        userId,
        idempotencyKey: getOpeningGrantIdempotencyKey(userId),
      });

      return {
        profileId: newProfile.id,
        userRole: normalizeUserRole(newProfile.role),
        userStatus: normalizeUserStatus(newProfile.status),
        userScopedSupabase,
      };
    }

    if (openingGrantLookupError) {
      logger.error('auth', 'profile_opening_grant_lookup_failed', {
        userId,
        error: getErrorMessage(openingGrantLookupError),
      });

      throw createProfileBootstrapError('opening_grant_failed');
    }

    const { error: cleanupError } = await cleanupSafeBootstrapProfile(ctx, userId);

    if (cleanupError) {
      logger.error('auth', 'profile_opening_grant_cleanup_failed', {
        userId,
        error: getErrorMessage(cleanupError),
      });
    }

    throw createProfileBootstrapError('opening_grant_failed');
  }

  return {
    profileId: newProfile.id,
    userRole: normalizeUserRole(newProfile.role),
    userStatus: normalizeUserStatus(newProfile.status),
    userScopedSupabase,
  };
}

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }

  if (!ctx.isEmailVerified) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'EMAIL_NOT_VERIFIED',
    });
  }

  const { profileId, userRole, userStatus, userScopedSupabase } = await ensureProfile(ctx);

  if (userStatus === 'disabled') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '账号已被禁用，请联系管理员',
    });
  }

  if (userStatus === 'banned') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '账号已被封禁',
    });
  }

  return next({
    ctx: {
      ...ctx,
      supabase: userScopedSupabase,
      userScopedSupabase,
      user: ctx.user,
      profileId,
      userRole,
      userStatus,
    },
  });
});

/**
 * Admin procedure - requires user to have admin role
 * Extends protectedProcedure with additional role check
 */
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.userRole !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to access this resource. Admin role required.',
    });
  }

  if (!ctx.hasSupabaseAdminPrivileges) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Supabase service role credentials are not configured.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      supabase: ctx.supabaseAdmin,
      userScopedSupabase: ctx.userScopedSupabase,
    },
  });
});
