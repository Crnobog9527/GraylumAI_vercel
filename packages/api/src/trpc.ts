import { initTRPC, TRPCError } from '@trpc/server';
import { createClient } from '@supabase/supabase-js';

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Extract JWT token from Authorization header
  const authHeader = opts.headers.get('authorization') ?? '';
  const token = authHeader.replace('Bearer ', '');

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        authorization: authHeader,
      },
    },
  });

  // Pass token directly to getUser() for server-side JWT validation
  let user = null;
  if (token) {
    const { data: { user: authUser } } = await supabase.auth.getUser(token);
    user = authUser;
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
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});
