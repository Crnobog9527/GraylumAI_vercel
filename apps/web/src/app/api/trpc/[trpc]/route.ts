import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';

const handler = async (req: NextRequest) => {
  const cookieStore = await cookies();

  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({
      headers: req.headers,
      cookies: cookieStore,
    }),
  });
};

export { handler as GET, handler as POST };
