import type { NextRequest } from 'next/server';
import { handlePlanRead } from '@repo/api/src/services/turn/planHttp';
import { turnClients } from '@repo/api/src/services/turn/db';
import { turnEnvironment } from '../environment';

export const runtime = 'nodejs';

/** CORE-PATH-V2 V2-10b GET /api/turn/plan: a request's plan turn and its plan. */
export async function GET(request: NextRequest) {
  const env = turnEnvironment(request);
  if (!env) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  return handlePlanRead(request, { authenticate: env.authenticate, databaseHost: env.databaseHost, clients: turnClients(env.admin) });
}
