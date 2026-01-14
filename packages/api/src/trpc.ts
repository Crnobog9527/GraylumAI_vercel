import { initTRPC, TRPCError } from '@trpc/server';
import { createServerClient } from '@supabase/ssr';

// Generic cookie interface (compatible with Next.js cookies())
interface CookieStore {
  getAll(): { name: string; value: string }[];
}

export const createTRPCContext = async (opts: {
  headers: Headers;
  cookies: CookieStore;
}) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Create Supabase server client with cookie access
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return opts.cookies.getAll();
      },
    },
  });

  // Get user from session (reads from cookies)
  const { data: { user } } = await supabase.auth.getUser();

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
