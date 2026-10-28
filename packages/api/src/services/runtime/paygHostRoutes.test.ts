import { describe, expect, it } from 'vitest';

import { isAdmittedRoute } from './paygHostPolicy';

describe('admitted model routes', () => {
  it('admits Claude Haiku 5.5 only on the Anthropic line', () => {
    expect(isAdmittedRoute('anthropic/claude-haiku-5.5', 'anthropic')).toBe(true);
    for (const other of ['google-vertex/global', 'azure/global', 'amazon-bedrock', 'claude-on-aws', 'anthropic/us', '', 'openai'])
      expect(isAdmittedRoute('anthropic/claude-haiku-5.5', other), other).toBe(false);
  });

  it('does not admit neighbouring models by accident', () => {
    for (const model of ['anthropic/claude-haiku-5.5:batch', 'anthropic/claude-haiku-4.5', '~anthropic/claude-haiku-latest',
      'anthropic/claude-fable-5.1', 'anthropic/claude-haiku-5'])
      expect(isAdmittedRoute(model, 'anthropic'), model).toBe(false);
  });

  it('keeps the routes that were admitted before', () => {
    const before: Array<[string, string]> = [['anthropic/claude-sonnet-5.5', 'anthropic'], ['google/gemini-3.8-flash', 'google-ai-studio'],
      ['google/gemini-4-argon', 'google-ai-studio'], ['openai/gpt-6-luna', 'openai'], ['openai/gpt-6.1-sol', 'openai'],
      ['anthropic/claude-opus-5.5', 'anthropic']];
    for (const [model, route] of before) expect(isAdmittedRoute(model, route), model).toBe(true);
  });
});
