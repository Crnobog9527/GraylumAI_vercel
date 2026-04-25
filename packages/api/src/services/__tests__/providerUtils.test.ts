import { afterEach, describe, expect, it } from 'vitest';

import {
  getConfiguredProviderApiKey,
  getConfiguredProviderApiKeySource,
  getFallbackProviderApiKey,
} from '../providerUtils';

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
