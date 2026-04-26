/**
 * Token Counter Service Tests
 *
 * 测试 Token 计数服务 - 官方 API 和本地估算
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  estimateTokensFromString,
  estimateTokensFromMessage,
  estimateTokensFromMessages,
  estimateSystemTokens,
  estimateToolsTokens,
  quickEstimate,
  estimateOutputTokens,
  countTokens,
} from '../tokenCounter';

// ============================================
// estimateTokensFromString Tests
// ============================================

describe('estimateTokensFromString', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokensFromString('')).toBe(0);
  });

  it('should estimate English text correctly', () => {
    const englishText = 'Hello, how are you doing today?'; // ~8 words, ~32 chars
    const tokens = estimateTokensFromString(englishText);

    // English: ~4 chars per token, so ~8 tokens
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(15);
  });

  it('should estimate Chinese text correctly', () => {
    const chineseText = '你好，今天天气怎么样？我想出去走走。'; // 18 chars
    const tokens = estimateTokensFromString(chineseText);

    // Chinese: ~1.5 chars per token, so ~12 tokens
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(20);
  });

  it('should estimate mixed text correctly', () => {
    const mixedText = 'Hello 你好 World 世界'; // Mixed content
    const tokens = estimateTokensFromString(mixedText);

    expect(tokens).toBeGreaterThan(3);
    expect(tokens).toBeLessThan(15);
  });

  it('should handle long text', () => {
    const longText = 'Lorem ipsum '.repeat(1000); // ~12000 chars
    const tokens = estimateTokensFromString(longText);

    // Should be roughly 3000 tokens (12000 / 4)
    expect(tokens).toBeGreaterThan(2000);
    expect(tokens).toBeLessThan(5000);
  });

  it('should handle special characters', () => {
    const specialText = '!@#$%^&*()_+-=[]{}|;:\'"<>,.?/~`';
    const tokens = estimateTokensFromString(specialText);

    expect(tokens).toBeGreaterThan(0);
    expect(Number.isFinite(tokens)).toBe(true);
  });
});

// ============================================
// estimateTokensFromMessage Tests
// ============================================

describe('estimateTokensFromMessage', () => {
  it('should estimate string content messages', () => {
    const message = {
      role: 'user' as const,
      content: 'Hello, can you help me?',
    };

    const tokens = estimateTokensFromMessage(message);

    // Should include role overhead (~4 tokens) + content
    expect(tokens).toBeGreaterThan(4);
  });

  it('should estimate array content messages with text', () => {
    const message = {
      role: 'assistant' as const,
      content: [
        { type: 'text', text: 'Sure, I can help you with that.' },
        { type: 'text', text: 'What do you need?' },
      ],
    };

    const tokens = estimateTokensFromMessage(message);

    expect(tokens).toBeGreaterThan(10);
  });

  it('should estimate image blocks', () => {
    const message = {
      role: 'user' as const,
      content: [
        { type: 'image', source: { type: 'base64', data: 'abc' } },
      ],
    };

    const tokens = estimateTokensFromMessage(message);

    // Images estimated at ~1000 tokens
    expect(tokens).toBeGreaterThanOrEqual(1000);
  });

  it('should estimate document blocks', () => {
    const message = {
      role: 'user' as const,
      content: [
        { type: 'document', source: { type: 'url', url: 'test.pdf' } },
      ],
    };

    const tokens = estimateTokensFromMessage(message);

    // Documents estimated at ~2000 tokens
    expect(tokens).toBeGreaterThanOrEqual(2000);
  });
});

// ============================================
// estimateTokensFromMessages Tests
// ============================================

describe('estimateTokensFromMessages', () => {
  it('should sum up all message tokens', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
      { role: 'user' as const, content: 'How are you?' },
    ];

    const tokens = estimateTokensFromMessages(messages);

    // Each message ~5-10 tokens + overhead
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(50);
  });

  it('should return overhead for empty array', () => {
    const tokens = estimateTokensFromMessages([]);

    // Should have format overhead (~5 tokens)
    expect(tokens).toBe(5);
  });

  it('should handle conversation with context', () => {
    const conversation = [
      { role: 'user' as const, content: '你好，我想了解一下人工智能的发展历史。' },
      { role: 'assistant' as const, content: '人工智能的发展可以追溯到1950年代...' },
      { role: 'user' as const, content: '那现在最先进的AI技术是什么？' },
      { role: 'assistant' as const, content: '目前最先进的AI技术包括大语言模型...' },
    ];

    const tokens = estimateTokensFromMessages(conversation);

    expect(tokens).toBeGreaterThan(50);
  });
});

// ============================================
// estimateSystemTokens Tests
// ============================================

describe('estimateSystemTokens', () => {
  it('should return 0 for undefined system prompt', () => {
    expect(estimateSystemTokens(undefined)).toBe(0);
  });

  it('should return 0 for empty string', () => {
    expect(estimateSystemTokens('')).toBe(0);
  });

  it('should estimate system prompt with overhead', () => {
    const systemPrompt = 'You are a helpful assistant.';
    const tokens = estimateSystemTokens(systemPrompt);

    // Should be string tokens + 10 overhead
    const stringTokens = estimateTokensFromString(systemPrompt);
    expect(tokens).toBe(stringTokens + 10);
  });

  it('should handle long system prompts', () => {
    const longPrompt = `
      You are a highly skilled AI assistant specialized in software development.
      You have expertise in TypeScript, React, Node.js, and cloud technologies.
      Always provide detailed explanations and working code examples.
      Follow best practices and coding standards.
    `.trim();

    const tokens = estimateSystemTokens(longPrompt);

    expect(tokens).toBeGreaterThan(50);
  });
});

// ============================================
// estimateToolsTokens Tests
// ============================================

describe('estimateToolsTokens', () => {
  it('should return 0 for undefined tools', () => {
    expect(estimateToolsTokens(undefined)).toBe(0);
  });

  it('should return 0 for empty tools array', () => {
    expect(estimateToolsTokens([])).toBe(0);
  });

  it('should estimate tool definitions', () => {
    const tools = [
      {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
          },
          required: ['location'],
        },
      },
    ];

    const tokens = estimateToolsTokens(tools);

    // Should include name, description, schema, and overhead
    expect(tokens).toBeGreaterThan(30);
  });

  it('should scale with number of tools', () => {
    const tools = [
      {
        name: 'tool1',
        description: 'Description 1',
        input_schema: { type: 'object' },
      },
      {
        name: 'tool2',
        description: 'Description 2',
        input_schema: { type: 'object' },
      },
      {
        name: 'tool3',
        description: 'Description 3',
        input_schema: { type: 'object' },
      },
    ];

    const singleToolTokens = estimateToolsTokens([tools[0]]);
    const multiToolTokens = estimateToolsTokens(tools);

    expect(multiToolTokens).toBeGreaterThan(singleToolTokens * 2);
  });
});

// ============================================
// quickEstimate Tests
// ============================================

describe('quickEstimate', () => {
  it('should be same as estimateTokensFromString', () => {
    const text = 'Test string for quick estimate';

    expect(quickEstimate(text)).toBe(estimateTokensFromString(text));
  });

  it('should handle empty string', () => {
    expect(quickEstimate('')).toBe(0);
  });
});

// ============================================
// estimateOutputTokens Tests
// ============================================

describe('estimateOutputTokens', () => {
  it('should estimate chat output tokens', () => {
    const result = estimateOutputTokens(1000, 'chat');

    // Chat ratio is 0.5, so 500 tokens, but minimum is 100
    expect(result).toBe(500);
  });

  it('should estimate coding output tokens', () => {
    const result = estimateOutputTokens(1000, 'coding');

    // Coding ratio is 1.5, so 1500 tokens
    expect(result).toBe(1500);
  });

  it('should estimate summary output tokens', () => {
    const result = estimateOutputTokens(1000, 'summary');

    // Summary ratio is 0.3, so 300 tokens
    expect(result).toBe(300);
  });

  it('should estimate translation output tokens', () => {
    const result = estimateOutputTokens(1000, 'translation');

    // Translation ratio is 1.0, so 1000 tokens
    expect(result).toBe(1000);
  });

  it('should respect minimum of 100 tokens', () => {
    const result = estimateOutputTokens(10, 'summary');

    // 10 * 0.3 = 3, but minimum is 100
    expect(result).toBe(100);
  });

  it('should respect maximum of 4096 tokens', () => {
    const result = estimateOutputTokens(10000, 'coding');

    // 10000 * 1.5 = 15000, but maximum is 4096
    expect(result).toBe(4096);
  });

  it('should default to chat ratio', () => {
    const chatResult = estimateOutputTokens(1000, 'chat');
    const defaultResult = estimateOutputTokens(1000);

    expect(defaultResult).toBe(chatResult);
  });
});

// ============================================
// countTokens Tests
// ============================================

describe('countTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fall back to estimate when official API fails', async () => {
    const result = await countTokens({
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.method).toBe('estimate');
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it('should use estimate only when useOfficial is false', async () => {
    const result = await countTokens(
      {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      { useOfficial: false }
    );

    expect(result.method).toBe('estimate');
    expect(result.breakdown).toBeDefined();
  });

  it('should include breakdown in estimate results', async () => {
    const result = await countTokens(
      {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are helpful',
        tools: [{
          name: 'test',
          description: 'Test tool',
          input_schema: { type: 'object' },
        }],
      },
      { useOfficial: false }
    );

    expect(result.breakdown).toBeDefined();
    expect(result.breakdown!.messages).toBeGreaterThan(0);
    expect(result.breakdown!.system).toBeGreaterThan(0);
    expect(result.breakdown!.tools).toBeGreaterThan(0);
  });

  it('should throw when official fails and fallback disabled', async () => {
    await expect(
      countTokens(
        {
          model: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        { useOfficial: true, fallbackToEstimate: false }
      )
    ).rejects.toThrow();
  });
});

// ============================================
// Edge Cases
// ============================================

describe('Edge Cases', () => {
  it('should handle Unicode characters', () => {
    const unicodeText = '🚀 Emoji test 你好 مرحبا שלום';
    const tokens = estimateTokensFromString(unicodeText);

    expect(tokens).toBeGreaterThan(0);
    expect(Number.isFinite(tokens)).toBe(true);
  });

  it('should handle very long strings', () => {
    const longText = 'a'.repeat(1_000_000); // 1 million chars
    const tokens = estimateTokensFromString(longText);

    // English: 1M / 4 = 250K tokens
    expect(tokens).toBe(250000);
  });

  it('should handle newlines and whitespace', () => {
    const textWithWhitespace = '  Hello  \n\n  World  \t\t  ';
    const tokens = estimateTokensFromString(textWithWhitespace);

    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle code blocks', () => {
    const codeBlock = `
function hello() {
  console.log('Hello, World!');
}

const result = hello();
    `.trim();

    const tokens = estimateTokensFromString(codeBlock);

    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(50);
  });
});
