/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { characterAccuracy } from '../ocr/accuracy';

it('scores like the evaluation tool: spaces and full-width forms do not count', () => {
  expect(characterAccuracy('扫描 件 识别', '扫描件识别')).toBe(1);
  expect(characterAccuracy('ABCD', 'ＡＢＣＤ')).toBe(1);
  expect(characterAccuracy('abcd', 'abxd')).toBe(0.75);
  expect(characterAccuracy('abcd', '')).toBe(0);
  expect(characterAccuracy('', '')).toBe(1);
});
