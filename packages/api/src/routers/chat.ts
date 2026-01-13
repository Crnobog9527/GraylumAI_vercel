import { router, publicProcedure } from '../trpc';
import { z } from 'zod';

export const chatRouter = router({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .query(({ input }) => {
      return { greeting: `Hello ${input.text}` };
    }),
});
