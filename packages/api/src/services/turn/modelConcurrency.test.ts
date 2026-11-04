/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../lib/logger';
import { paygProductionSettings } from './admission/paygHostPolicy';
import { DEFAULT_MODEL_CONCURRENCY, MAX_MODEL_CONCURRENCY, modelConcurrency } from './quote';

/* CORE-PATH-V2 3.3.2 item 10: the in-flight limit of each model, from runtime_payg.modelConcurrency (quote.ts). */
const MODEL = 'openai/gpt-6-luna';
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
beforeEach(() => { warn.mockClear(); });

describe('per-model in-flight limit', () => {
  it('uses the configured value of the model', () => {
    expect(modelConcurrency({ modelConcurrency: { [MODEL]: 200 } }, MODEL)).toBe(200);
    expect(modelConcurrency({ modelConcurrency: { [MODEL]: 1 } }, MODEL)).toBe(1);
    expect(modelConcurrency({ modelConcurrency: { [MODEL]: MAX_MODEL_CONCURRENCY } }, MODEL)).toBe(MAX_MODEL_CONCURRENCY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is 150 without a value for the model, or without the map at all', () => {
    expect(DEFAULT_MODEL_CONCURRENCY).toBe(150);
    expect(modelConcurrency({}, MODEL)).toBe(150);
    expect(modelConcurrency({ modelConcurrency: { 'anthropic/claude-sonnet-5.5': 40 } }, MODEL)).toBe(150);
    // An inherited name is not a configured value.
    expect(modelConcurrency({ modelConcurrency: {} }, 'constructor')).toBe(150);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to 150 and logs on a value that is not an integer from 1 to the maximum', () => {
    for (const bad of [0, -5, 2.5, Number.NaN, Infinity, MAX_MODEL_CONCURRENCY + 1, '200', null, true]) {
      warn.mockClear();
      expect(modelConcurrency({ modelConcurrency: { [MODEL]: bad } }, MODEL), String(bad)).toBe(150);
      expect(warn).toHaveBeenCalledWith('ai', 'turn_model_concurrency_invalid', { model: MODEL });
    }
  });

  it('a bad value never disables the setting: the map accepts it and only that model falls back', () => {
    const shape = paygProductionSettings.shape;
    // The map itself is optional and takes any value per model; the per-value check is modelConcurrency's.
    expect(shape.modelConcurrency.safeParse(undefined).success).toBe(true);
    expect(shape.modelConcurrency.safeParse({ [MODEL]: 0, other: 'x' }).success).toBe(true);
    // Only a map: a list or a number is a malformed setting, refused like any other malformed field.
    expect(shape.modelConcurrency.safeParse([1]).success).toBe(false);
    expect(shape.modelConcurrency.safeParse(5).success).toBe(false);
  });
});
