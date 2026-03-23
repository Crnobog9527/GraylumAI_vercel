import { describe, expect, it } from 'vitest';
import {
  BLOCKED_AI_OUTPUT_MESSAGE,
  filterAIOutput,
} from '../aiOutputFilter';

describe('filterAIOutput', () => {
  it('keeps safe content unchanged', () => {
    const result = filterAIOutput('这是一个正常回复，用于解释产品能力。');

    expect(result).toEqual({
      content: '这是一个正常回复，用于解释产品能力。',
      blocked: false,
      sanitized: false,
      reasons: [],
    });
  });

  it('sanitizes PII-style output instead of returning it raw', () => {
    const result = filterAIOutput('请联系 alice@example.com 获取帮助。');

    expect(result.blocked).toBe(false);
    expect(result.sanitized).toBe(true);
    expect(result.content).not.toContain('alice@example.com');
    expect(result.reasons).toContain('pii_leak');
  });

  it('sanitizes leaked secret-like values detected by output security checks', () => {
    const result = filterAIOutput('api_key = "abcdefghij1234567890abcd"');

    expect(result.blocked).toBe(false);
    expect(result.sanitized).toBe(true);
    expect(result.content).not.toContain('abcdefghij1234567890abcd');
    expect(result.reasons).toContain('sensitive_content');
  });

  it('blocks harmful output instead of returning it', () => {
    const result = filterAIOutput('how to make a bomb at home');

    expect(result).toEqual({
      content: BLOCKED_AI_OUTPUT_MESSAGE,
      blocked: true,
      sanitized: false,
      reasons: ['harmful_content'],
    });
  });
});
