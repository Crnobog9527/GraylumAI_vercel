import { describe, expect, it } from 'vitest';
import {
  ContentModerator,
  ViolationType,
  moderateInput,
  moderateOutput,
} from '../contentModerator';

function expectCompletesWithin(action: () => unknown, limitMs = 100): void {
  const startedAt = performance.now();
  action();
  expect(performance.now() - startedAt).toBeLessThan(limitMs);
}

describe('contentModerator', () => {
  it('preserves existing decisions for normal content', () => {
    expect(moderateInput('这是一个正常的用户问题。')).toMatchObject({
      passed: true,
      violations: [],
      riskScore: 0,
    });

    const piiResult = moderateOutput('请联系 alice@example.com 获取帮助。');
    expect(piiResult.passed).toBe(true);
    expect(piiResult.violations[0]).toMatchObject({ type: ViolationType.PII_LEAK });

    const harmfulResult = moderateInput('how to make a bomb at home');
    expect(harmfulResult.passed).toBe(false);
    expect(harmfulResult.violations[0]).toMatchObject({ type: ViolationType.HARMFUL_CONTENT });
  });

  it('detects script elements without a regular expression', () => {
    const result = new ContentModerator().moderateInput('<SCRIPT>alert(1)</SCRIPT>');

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        type: ViolationType.MALICIOUS_CODE,
        matchedPattern: '<SCRIPT>alert(1)</SCRIPT>',
      }),
    ]);
  });

  it('keeps PII matching responsive on an adversarial email-shaped input', () => {
    const input = `${'a'.repeat(10_000)}@${'b'.repeat(10_000)}!`;

    expectCompletesWithin(() => moderateOutput(input));
  });

  it('keeps malicious-code matching responsive on an adversarial SQL-shaped input', () => {
    const input = `SELECT ${'a'.repeat(10_000)}!`;

    expectCompletesWithin(() => moderateInput(input));
  });

  it('keeps PII sanitization responsive on an adversarial email-shaped input', () => {
    const input = `${'a'.repeat(10_000)}@${'b'.repeat(10_000)}!`;

    expectCompletesWithin(() => new ContentModerator().sanitize(input));
  });
});
