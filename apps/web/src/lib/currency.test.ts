import { describe, expect, it } from 'vitest';
import { formatReportUsd, formatReportUsdShort } from './currency';

describe('formatReportUsd', () => {
  it.each([
    [0, '$0.00'],
    [0.0005, '$0.0005'],
    [0.00000000003, '$0.00000000003'],
    [1234567.89, '$1,234,567.89'],
    [13110.37, '$13,110.37'],
    [-0.0005, '-$0.0005'],
    [-12.5, '-$12.50'],
    [0.0000000000001, '<$0.000000000001'],
    [-0.0000000000001, '-<$0.000000000001'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatReportUsd(value)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'shows a placeholder instead of a fabricated amount for %s',
    (value) => {
      expect(formatReportUsd(value)).toBe('—');
    },
  );
});

describe('formatReportUsdShort', () => {
  it.each([
    [-0.0406667806, '-$0.04067'],
    [0.001626671224, '$0.001627'],
    [0.5, '$0.50'],
    [0.0005, '$0.0005'],
    [0.99996, '$1.00'],
    [13110.3712, '$13,110.37'],
    [-12.5, '-$12.50'],
    [0, '$0.00'],
    [0.00000000003, '$0.00000000003'],
    [0.0000000000001, '<$0.000000000001'],
  ])('shortens %s to %s', (value, expected) => {
    expect(formatReportUsdShort(value)).toBe(expected);
  });

  it('shows a placeholder for non-finite amounts', () => {
    expect(formatReportUsdShort(Number.NaN)).toBe('—');
  });
});
