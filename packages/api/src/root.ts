import { router } from './trpc';
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';
import { ticketRouter } from './routers/ticket';
import { settingsRouter } from './routers/settings';

/**
 * 主路由器
 *
 * 在这里注册所有子路由器
 */
export const appRouter = router({
  chat: chatRouter,
  user: userRouter,
  credits: creditsRouter,
  ticket: ticketRouter,
  settings: settingsRouter,
});

/**
 * 导出类型供客户端使用
 */
export type AppRouter = typeof appRouter;
