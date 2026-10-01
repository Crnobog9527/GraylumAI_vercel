/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Select complete credential pairs. Never mix a URL from one namespace with another token. */
export function redisEnvironment(env: NodeJS.ProcessEnv) {
  const canonical = [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN];
  if (canonical.some(Boolean)) {
    if (!canonical.every(Boolean)) throw new Error('REDIS_ENV_INCOMPLETE');
    return { url: canonical[0]!, token: canonical[1]! };
  }
  const integrated = [env.KV_REST_API_URL, env.KV_REST_API_TOKEN];
  if (!integrated.every(Boolean)) throw new Error('REDIS_ENV_INCOMPLETE');
  return { url: integrated[0]!, token: integrated[1]! };
}
