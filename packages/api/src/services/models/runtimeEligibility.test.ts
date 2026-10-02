/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runtimeModelOption } from './runtimeEligibility';
import { withStoredManagedKeys } from './modelConfig';

const reasoning = { route: 'deepinfra', purposes: { interactive: { mode: 'off', wire: 'reasoning_effort' } }, catalog: {
  fetchedAt: '2026-09-29T00:00:00.000Z', model: 'deepseek/deepseek-v4.1-flash',
  reasoning: { mandatory: false, defaultEnabled: true, supportedEfforts: ['low'], defaultEffort: 'low', supportsMaxTokens: false },
  endpoints: [{ tag: 'deepinfra', providerName: 'DeepInfra', supportedParameters: ['tools', 'reasoning_effort'], contextLength: 100000, maxCompletionTokens: 8192 }] } };
const row = (patch: Record<string, unknown> = {}) => ({ id: '11111111-1111-4111-8111-111111111111', name: 'DeepSeek', model_id: 'deepseek/deepseek-v4.1-flash',
  provider: 'openai', is_active: 'true', max_tokens: 8192, input_limit: 100000, api_key: 'SECRET_CANARY', api_endpoint: '', config: { reasoning }, ...patch });

describe('runtimeModelOption', () => {
  it('allows a configured model the old fixed list never allowed, for both uses, without returning the key', () => {
    for (const use of ['skill', 'organizer'] as const) {
      const option = runtimeModelOption(row(), use);
      expect(option).toEqual({ id: row().id, name: 'DeepSeek', model_id: 'deepseek/deepseek-v4.1-flash', available: true, reason: null });
      expect(JSON.stringify(option)).not.toContain('SECRET_CANARY');
    }
  });

  it('needs the interactive setting for a Skill model but not for the organizer', () => {
    const unconfigured = row({ config: null });
    expect(runtimeModelOption(unconfigured, 'skill')).toMatchObject({ available: false, reason: '请先在模型管理的"思考设置"里设置"交互对话"' });
    expect(runtimeModelOption(unconfigured, 'organizer')).toMatchObject({ available: true });
  });

  it('refuses a config that fails its checks for either use', () => {
    const stale = row({ model_id: 'qwen/qwen3.8-flash' });
    for (const use of ['skill', 'organizer'] as const) expect(runtimeModelOption(stale, use)).toMatchObject({ available: false, reason: expect.stringContaining('重新读取目录') });
  });

  it.each([
    [{ is_active: 'false' }, '模型已停用'],
    [{ api_key: ' ' }, '请先配置 API 密钥'],
    [{ provider: 'anthropic', api_endpoint: 'https://api.anthropic.com/v1/messages' }, '当前 Runtime 需要 OpenRouter 接口'],
    [{ model_id: 'openrouter/auto' }, '模型 ID 格式不受支持'],
    [{ max_tokens: 0 }, '请设置有效的输出上限'],
    [{ input_limit: 8192 }, '请设置有效的上下文容量'],
  ])('refuses %j', (patch, reason) => {
    expect(runtimeModelOption(row(patch), 'organizer')).toMatchObject({ available: false, reason });
  });
});

describe('withStoredManagedKeys', () => {
  it('keeps the stored reasoning and ignores one in a generic write', () => {
    expect(withStoredManagedKeys({ connection_status: 'ok', reasoning: { forged: true } }, { reasoning, last_error: 'x' }))
      .toEqual({ connection_status: 'ok', reasoning });
    expect(withStoredManagedKeys({ connection_status: 'ok', reasoning: { forged: true } }, null)).toEqual({ connection_status: 'ok' });
  });
});
