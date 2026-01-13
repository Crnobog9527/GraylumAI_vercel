import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { router } from './trpc';

export const appRouter = router({
  chat: chatRouter,
  user: userRouter,
});

export type AppRouter = typeof appRouter;
