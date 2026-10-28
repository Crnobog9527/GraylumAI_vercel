import type { NextRequest } from 'next/server';
import { handleTurnStop } from '@repo/api/src/services/turn/reportHttp';
import { turnClients } from '@repo/api/src/services/turn/db';
import { turnEnvironment } from '../environment';

export const runtime = 'nodejs';

/** CORE-PATH-V2 V2-7a POST /api/turn/stop: the user's stop of a running report (the only kind that can be stopped). */
export async function POST(request: NextRequest) {
  const env = turnEnvironment(request);
  if (!env) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  return handleTurnStop(request, { authenticate: env.authenticate, databaseHost: env.databaseHost, clients: turnClients(env.admin) });
}
