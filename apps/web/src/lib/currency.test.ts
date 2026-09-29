import { describe, expect, it } from 'vitest';
import { formatReportUsd } from './currency';

describe('formatReportUsd', () => {
  it.each([
    [0, '$0.00'],
    [0.0005, '$0.0005'],
    [0.00000000003, '$0.00000000003'],
    [1234567.89, '$1,234,567.89'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatReportUsd(value)).toBe(expected);
  });
});
