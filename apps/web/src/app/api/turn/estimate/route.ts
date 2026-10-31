import type { NextRequest } from 'next/server';
import { readTurnRouteEnv } from '@repo/api/src/lib/envValidator';
import { withCatalogRequest } from '@repo/api/src/services/runtime/catalogCache';
import { newWorkGate } from '@repo/api/src/services/runtime/newWorkGate';
import { withPlatformSecretRequest } from '@repo/api/src/services/platformSecrets/request';
import { checkRateLimit } from '@repo/api/src/services/redisRateLimiter';
import { handleTurnEstimate } from '@repo/api/src/services/turn/fusionHttp';
import { redisCounterStore } from '@repo/api/src/services/turn/limiter';
import { turnClients } from '@repo/api/src/services/turn/db';
import { turnEnvironment } from '../environment';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** CORE-PATH-V2 V2-7b POST /api/turn/estimate: the maximum a compare or a jury would freeze, before the user agrees. */
export async function POST(request: NextRequest) {
  const env = turnEnvironment(request);
  if (!env) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  const { admin, authenticate, databaseHost, userClient } = env;
  return withPlatformSecretRequest(() => withCatalogRequest(() => handleTurnEstimate(request, { authenticate, databaseHost, userClient,
    rateLimited: async actorId => !(await checkRateLimit(actorId, 'api')).success,
    chat: { admin, clients: turnClients(admin), slots: redisCounterStore(), newWork: newWorkGate(admin, readTurnRouteEnv().environment) },
  })));
}
