import type { NextRequest } from 'next/server';
import { handleReportRead } from '@repo/api/src/services/turn/reportHttp';
import { turnClients } from '@repo/api/src/services/turn/db';
import { turnEnvironment } from '../environment';

export const runtime = 'nodejs';

/** CORE-PATH-V2 V2-7a GET /api/turn/report: the newest report turn of a round (or one turn) with its saved text. */
export async function GET(request: NextRequest) {
  const env = turnEnvironment(request);
  if (!env) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  return handleReportRead(request, { authenticate: env.authenticate, databaseHost: env.databaseHost, clients: turnClients(env.admin) });
}
