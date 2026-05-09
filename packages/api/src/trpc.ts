import { initTRPC, TRPCError } from '@trpc/server';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { getAuthProvider, isEmailVerified } from './lib/auth';
import { ensureWorkspaceServerEnv } from './lib/serverEnv';
import { logger } from './lib/logger';

type ApiSupabaseClient = SupabaseClient<any, 'public', any>;

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
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

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
    supabaseAdmin,
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }

  return String(error);
}

async function applyOpeningGrant(ctx: Awaited<ReturnType<typeof createTRPCContext>>, userId: string) {
  const { data, error } = await ctx.supabaseAdmin.rpc('atomic_apply_credit_ledger_entry', {
    p_user_id: userId,
    p_amount: OPENING_GRANT_CREDITS,
    p_type: 'addition',
    p_description: 'Opening grant for new user profile bootstrap',
    p_idempotency_key: `opening_grant:${userId}`,
  });

  if (error) {
    throw error;
  }

  const ledgerEntry = data?.[0];
  if (!ledgerEntry) {
    throw new Error('atomic opening grant ledger RPC returned no rows');
  }
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

  // Try to get user profile (foreign keys reference profiles.id)
  let profileId = ctx.user.id;
  let userRole: 'user' | 'admin' = 'user';
  let userStatus: 'active' | 'disabled' | 'banned' = 'active';
  const userScopedSupabase = ctx.supabaseAuth ?? ctx.supabase;
  const derivedNickname = deriveProfileNickname(ctx.user);
  const normalizedEmail = ctx.user.email ?? null;

  const { data: profile, error: profileError } = await userScopedSupabase
    .from('profiles')
    .select('id, role, credits, status, nickname, email')
    .eq('id', ctx.user.id)
    .single();

  if (!profile || profileError) {
    // Profile doesn't exist, create one with id and email
    // First check if it's a "not found" error vs other errors
    const isNotFound = profileError?.code === 'PGRST116';

    if (isNotFound) {
      // Profile doesn't exist, try to create one
      const { data: newProfile, error: createError } = await userScopedSupabase
        .from('profiles')
        .insert({
          id: ctx.user.id,
          email: normalizedEmail,
          nickname: derivedNickname,
          role: 'user',
          credits: 0,
        })
        .select('id, role, credits, status, nickname, email')
        .single();

      if (createError) {
        logger.error('auth', 'profile_create_failed', {
          code: createError.code,
          conflict: createError.code === '23505',
        });

        // If insert failed due to conflict (profile already exists), try to fetch again
        if (createError.code === '23505') {
          const { data: existingProfile } = await userScopedSupabase
              .from('profiles')
              .select('id, role, credits, status, nickname, email')
              .eq('id', ctx.user.id)
              .single();

          if (existingProfile) {
            profileId = existingProfile.id;
            userRole = existingProfile.role || 'user';
            userStatus = existingProfile.status || 'active';
          } else {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: '无法获取用户资料，请稍后重试',
            });
          }
        } else {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: '创建用户资料失败，请联系客服',
          });
        }
      } else if (newProfile) {
        try {
          await applyOpeningGrant(ctx, ctx.user.id);
        } catch (openingGrantError) {
          logger.error('auth', 'profile_opening_grant_failed', {
            userId: ctx.user.id,
            error: getErrorMessage(openingGrantError),
          });

          const { error: cleanupError } = await ctx.supabaseAdmin
            .from('profiles')
            .delete()
            .eq('id', ctx.user.id);

          if (cleanupError) {
            logger.error('auth', 'profile_opening_grant_cleanup_failed', {
              userId: ctx.user.id,
              error: getErrorMessage(cleanupError),
            });
          }

          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: '创建用户资料失败，请联系客服',
          });
        }

        profileId = newProfile.id;
        userRole = newProfile.role || 'user';
        userStatus = newProfile.status || 'active';
      }
    } else {
      // Other database error
      logger.error('auth', 'profile_query_failed', {
        code: profileError?.code ?? null,
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '获取用户资料失败，请稍后重试',
      });
    }
  } else {
    profileId = profile.id;
    userRole = profile.role || 'user';
    userStatus = profile.status || 'active';

    const shouldBackfillNickname = !profile.nickname?.trim();
    const shouldSyncEmail = normalizedEmail && profile.email !== normalizedEmail;

    if (shouldBackfillNickname || shouldSyncEmail) {
      await userScopedSupabase
        .from('profiles')
        .update({
          ...(shouldBackfillNickname ? { nickname: derivedNickname } : {}),
          ...(shouldSyncEmail ? { email: normalizedEmail } : {}),
        })
        .eq('id', ctx.user.id);
    }
  }

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
    },
  });
});
