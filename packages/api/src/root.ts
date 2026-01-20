import { router } from './trpc';
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';
import { ticketRouter } from './routers/ticket';
import { settingsRouter } from './routers/settings';
import { modelRouter } from './routers/model';
import { invitationRouter } from './routers/invitation';
import { adminRouter } from './routers/admin';
import { modulesRouter } from './routers/modules';

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
  model: modelRouter,
  invitation: invitationRouter,
  admin: adminRouter,
  modules: modulesRouter,
});

/**
 * 导出类型供客户端使用
 */
export type AppRouter = typeof appRouter;
