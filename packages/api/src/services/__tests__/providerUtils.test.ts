import { afterEach, describe, expect, it } from 'vitest';

import {
  getConfiguredProviderApiKey,
  getConfiguredProviderApiKeySource,
  getFallbackProviderApiKey,
  isOpenRouterEndpoint,
} from '../providerUtils';

it('binds OpenRouter capabilities to the official HTTPS origin and full endpoint',()=>{
  for(const url of ['https://openrouter.ai/api/v1/chat/completions','https://openrouter.ai:443/api/v1/chat/completions'])expect(isOpenRouterEndpoint(url)).toBe(true);
  for(const url of ['https://openrouter.ai:8443/api/v1/chat/completions','https://openrouter.ai.evil.test/api/v1/chat/completions','https://user@openrouter.ai/api/v1/chat/completions','http://openrouter.ai/api/v1/chat/completions','https://openrouter.ai/api/v1/chat/completions?preset=research'])expect(isOpenRouterEndpoint(url)).toBe(false);
});

describe('providerUtils API key precedence', () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('prefers the model-level API key over environment fallback keys', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-env-fallback';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';

    expect(getConfiguredProviderApiKey('sk-or-db-key')).toBe('sk-or-db-key');
    expect(getConfiguredProviderApiKeySource('sk-or-db-key')).toBe('database');
  });

  it('falls back to OPENROUTER_API_KEY when no model key is present', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-env-fallback';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';

    expect(getFallbackProviderApiKey()).toBe('sk-or-env-fallback');
    expect(getConfiguredProviderApiKey()).toBe('sk-or-env-fallback');
    expect(getConfiguredProviderApiKeySource()).toBe('env:OPENROUTER_API_KEY');
  });

  it('does not use ANTHROPIC_API_KEY as a fallback provider key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';

    expect(getFallbackProviderApiKey()).toBeNull();
    expect(getConfiguredProviderApiKey()).toBeNull();
    expect(getConfiguredProviderApiKeySource()).toBeNull();
  });
});
