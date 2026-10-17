import { expect, it } from 'vitest';

import { isOpenRouterEndpoint } from '../providerUtils';

it('binds OpenRouter capabilities to the official HTTPS origin and full endpoint',()=>{
  for(const url of ['https://openrouter.ai/api/v1/chat/completions','https://openrouter.ai:443/api/v1/chat/completions'])expect(isOpenRouterEndpoint(url)).toBe(true);
  for(const url of ['https://openrouter.ai:8443/api/v1/chat/completions','https://openrouter.ai.evil.test/api/v1/chat/completions','https://user@openrouter.ai/api/v1/chat/completions','http://openrouter.ai/api/v1/chat/completions','https://openrouter.ai/api/v1/chat/completions?preset=research'])expect(isOpenRouterEndpoint(url)).toBe(false);
});

it('no longer offers an environment fallback for the OpenRouter key (ADMIN-SECRETS OR-1)', async () => {
  const utils = await import('../providerUtils');
  for (const name of ['getFallbackProviderApiKey', 'getConfiguredProviderApiKey', 'getConfiguredProviderApiKeySource'])
    expect(utils).not.toHaveProperty(name);
});
