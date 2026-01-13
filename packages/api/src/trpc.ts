import { initTRPC } from '@trpc/server';
export const createTRPCContext = async (opts: { headers: Headers }) => {
  return { ...opts };
};
const t = initTRPC.context<typeof createTRPCContext>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
