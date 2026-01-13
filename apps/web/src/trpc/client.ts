import { createTRPCReact } from '@trpc/react-query';
import { type AppRouter } from '@repo/api/src/root';

export const trpc = createTRPCReact<AppRouter>({});
