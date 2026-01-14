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

  // Try to get user profile (foreign keys reference profiles.id)
  // In most Supabase setups, profiles.id = auth.users.id
  let profileId = ctx.user.id;

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('id')
    .eq('id', ctx.user.id)
    .single();

  if (profile) {
    profileId = profile.id;
  }
  // If no profile exists, use ctx.user.id directly
  // (assumes profiles.id = auth.users.id pattern)

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      profileId,
    },
  });
});
