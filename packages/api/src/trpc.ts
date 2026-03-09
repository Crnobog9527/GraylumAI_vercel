import { initTRPC, TRPCError } from '@trpc/server';
import { createClient, type User } from '@supabase/supabase-js';

export const createTRPCContext = async (opts: { headers: Headers; user?: User | null }) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // Use service role key for server-side operations (bypasses RLS)
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Create Supabase client for database operations
  const supabase = createClient(supabaseUrl, supabaseKey);

  let user = opts.user ?? null;

  if (!user) {
    // Get token from Authorization header
    const authHeader = opts.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '');

    if (token) {
      const { data: { user: authUser }, error } = await supabase.auth.getUser(token);
      if (!error && authUser) {
        user = authUser;
      }
    }
  }

  return {
    ...opts,
    supabase,
    user,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }

  // Try to get user profile (foreign keys reference profiles.id)
  let profileId = ctx.user.id;
  let userRole: 'user' | 'admin' = 'user';
  let userStatus: 'active' | 'disabled' | 'banned' = 'active';

  const { data: profile, error: profileError } = await ctx.supabase
    .from('profiles')
    .select('id, role, credits, status')
    .eq('id', ctx.user.id)
    .single();

  if (!profile || profileError) {
    // Profile doesn't exist, create one with id and email
    // First check if it's a "not found" error vs other errors
    const isNotFound = profileError?.code === 'PGRST116';

    if (isNotFound) {
      // Profile doesn't exist, try to create one
      const { data: newProfile, error: createError } = await ctx.supabase
        .from('profiles')
        .insert({
          id: ctx.user.id,
          email: ctx.user.email,
          role: 'user',
          // credits property omitted to use database default of 100
        })
        .select('id, role, credits, status')
        .single();

      if (createError) {
        console.error('Failed to create profile:', createError.message, createError.code);

        // If insert failed due to conflict (profile already exists), try to fetch again
        if (createError.code === '23505') {
          const { data: existingProfile } = await ctx.supabase
            .from('profiles')
            .select('id, role, credits, status')
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
        profileId = newProfile.id;
        userRole = newProfile.role || 'user';
        userStatus = newProfile.status || 'active';
      }
    } else {
      // Other database error
      console.error('Profile query error:', profileError?.message, profileError?.code);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '获取用户资料失败，请稍后重试',
      });
    }
  } else {
    profileId = profile.id;
    userRole = profile.role || 'user';
    userStatus = profile.status || 'active';
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

  return next({ ctx });
});
