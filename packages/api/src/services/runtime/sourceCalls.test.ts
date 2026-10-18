/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {SOURCE_CALLS_FIRST, sourceReadFlags} from './sourceCalls';
import {runtimeContext} from './runtimeContext';

describe('sourceReadFlags', () => {
  it('freezes the marker only for executions that offer read_source, and the retrieval flag only when asked', () => {
    expect(sourceReadFlags(false, [])).toEqual({});
    expect(sourceReadFlags(false, ['search'])).toEqual({});
    expect(sourceReadFlags(false, ['read_source'])).toEqual({sourceCalls: SOURCE_CALLS_FIRST});
    expect(sourceReadFlags(true, ['read_source'])).toEqual({libraryRetrieval: true, sourceCalls: SOURCE_CALLS_FIRST});
  });
  it('is part of the frozen context schema (and nothing else is accepted for it)', () => {
    expect(runtimeContext.shape.sourceCalls.safeParse('first-call-v1').success).toBe(true);
    expect(runtimeContext.shape.sourceCalls.safeParse('anything').success).toBe(false);
  });
});
