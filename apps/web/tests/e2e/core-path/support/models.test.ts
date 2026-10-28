import { describe, expect, it } from 'vitest';

import { cheapestLine, cheapestOther, type CompareModel } from './models';

const model = (modelId: string, usdPerMillion: number): CompareModel => ({ id: modelId, modelId, name: modelId, usdPerMillion });

describe('compare model choice', () => {
  it('prices a model by its cheapest admissible line, prompt plus completion', () => {
    const config = { pricing: { endpoints: [
      { admissible: true, base: { prompt: '0.375', completion: '1.875' } },
      { admissible: true, base: { prompt: '0.5', completion: '3' } },
      { admissible: false, base: { prompt: '0.01', completion: '0.01' } }] } };
    expect(cheapestLine(config)).toBeCloseTo(2.25);
    expect(cheapestLine({})).toBeNull();
    expect(cheapestLine(null)).toBeNull();
  });

  it('picks the cheapest model other than the test model', () => {
    const list = [model('google/gemini-3.8-flash', 2.25), model('anthropic/claude-sonnet-5.5', 12),
      model('openai/gpt-6.1-sol', 6), model('anthropic/claude-opus-5.5', 24)];
    expect(cheapestOther(list)?.modelId).toBe('openai/gpt-6.1-sol');
    expect(cheapestOther(list, 'openai/gpt-6.1-sol')?.modelId).toBe('google/gemini-3.8-flash');
  });

  it('is null when the test model is the only model on the list', () => {
    expect(cheapestOther([model('google/gemini-3.8-flash', 2.25)])).toBeNull();
  });
});
