import { router } from '../trpc';
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';

/**
 * 主路由器
 * 
 * 在这里注册所有子路由器
 */
export const appRouter = router({
  chat: chatRouter,
  user: userRouter,
  credits: creditsRouter,
});

/**
 * 导出类型供客户端使用
 */
export type AppRouter = typeof appRouter;
