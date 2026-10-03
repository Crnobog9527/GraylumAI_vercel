/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
const { isValidMultiplierInput } = await import('./ModelMultiplierPanel');

describe('model multiplier input', () => {
  it.each(['', ' ', '1', '3', '1.5', '19.99', '20', '20.0', '20.00'])('accepts %j (blank inherits)', (value) =>
    expect(isValidMultiplierInput(value)).toBe(true));
  it.each(['0', '0.99', '-1', '20.01', '21', '1.234', 'abc', '3e0', '03', '3.'])('rejects %j', (value) =>
    expect(isValidMultiplierInput(value)).toBe(false));
});
