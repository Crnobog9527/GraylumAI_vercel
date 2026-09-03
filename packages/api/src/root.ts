import { router } from './trpc';
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';
import { ticketRouter } from './routers/ticket';
import { settingsRouter } from './routers/settings';
import { modelRouter } from './routers/model';
import { invitationRouter } from './routers/invitation';
import { checkinRouter } from './routers/checkin';
import { adminRouter } from './routers/admin';
import { modulesRouter } from './routers/modules';
import { aiRouter } from './routers/ai';
import { diagnosticsRouter } from './routers/diagnostics';
import { costsRouter } from './routers/costs';
import { paymentsRouter } from './routers/payments';
import { skillsRouter } from './routers/skills';

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
  checkin: checkinRouter,
  admin: adminRouter,
  modules: modulesRouter,
  ai: aiRouter,
  diagnostics: diagnosticsRouter,
  costs: costsRouter,
  payments: paymentsRouter,
  skills: skillsRouter,
});

/**
 * 导出类型供客户端使用
 */
export type AppRouter = typeof appRouter;
export type { AdminSkill } from './routers/skills';
