import { initTRPC, TRPCError } from '@trpc/server';
import { createClient } from '@supabase/supabase-js';

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // Use service role key for server-side operations (bypasses RLS)
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Create Supabase client for database operations
  const supabase = createClient(supabaseUrl, supabaseKey);

  let user = null;

  // Get token from Authorization header
  const authHeader = opts.headers.get('Authorization') ?? '';
  const token = authHeader.replace('Bearer ', '');

  if (token) {
    const { data: { user: authUser }, error } = await supabase.auth.getUser(token);
    if (!error && authUser) {
      user = authUser;
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

  // Get or create user profile (foreign keys reference profiles.id, not auth.users.id)
  let profileId = ctx.user.id;

  const { data: profile, error: profileError } = await ctx.supabase
    .from('profiles')
    .select('id')
    .eq('id', ctx.user.id)
    .single();

  if (profileError || !profile) {
    // Profile doesn't exist, create one
    const { data: newProfile, error: createError } = await ctx.supabase
      .from('profiles')
      .insert({
        id: ctx.user.id,
        email: ctx.user.email,
      })
      .select('id')
      .single();

    if (createError || !newProfile) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to create user profile: ${createError?.message || 'Unknown error'}`,
      });
    }
    profileId = newProfile.id;
  } else {
    profileId = profile.id;
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      profileId,
    },
  });
});
