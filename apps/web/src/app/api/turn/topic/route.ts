import type { NextRequest } from 'next/server';
import { readTurnRouteEnv } from '@repo/api/src/lib/envValidator';
import { withCatalogRequest } from '@repo/api/src/services/turn/settings/catalogCache';
import { newWorkGate } from '@repo/api/src/services/turn/admission/newWorkGate';
import { withPlatformSecretRequest } from '@repo/api/src/services/platformSecrets/request';
import { checkRateLimit } from '@repo/api/src/services/redisRateLimiter';
import { redisCounterStore } from '@repo/api/src/services/turn/limiter';
import { turnClients } from '@repo/api/src/services/turn/db';
import { handleTopicTurn } from '@repo/api/src/services/turn/topicHttp';
import { turnEnvironment } from '../environment';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** CORE-PATH-V2 V2-10b POST /api/turn/topic: one turn of the topic workspace, one stream. */
export async function POST(request: NextRequest) {
  const env = turnEnvironment(request);
  if (!env) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  const { admin, authenticate, databaseHost } = env;
  return withPlatformSecretRequest(() => withCatalogRequest(() => handleTopicTurn(request, { authenticate, databaseHost,
    rateLimited: async actorId => !(await checkRateLimit(actorId, 'ai_stream')).success,
    chat: { admin, clients: turnClients(admin), slots: redisCounterStore(), newWork: newWorkGate(admin, readTurnRouteEnv().environment) },
  })));
}
