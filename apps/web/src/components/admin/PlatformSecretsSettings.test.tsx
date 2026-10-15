/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const trpcState = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown }));
vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ platformSecrets: { status: { setData: vi.fn() } } }),
    platformSecrets: {
      status: { useQuery: () => ({ data: trpcState.data, error: trpcState.error, refetch: vi.fn() }) },
      set: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      clear: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
    },
  },
}));

import { PlatformSecretRow, PlatformSecretsSettings } from './PlatformSecretsSettings';
import { clearWarning, platformSecretError, sourceLabel, type PlatformSecretItem } from './platformSecretsView';

const base: PlatformSecretItem = { slot: 'postforme', configured: false, last4: null, revision: 0, updatedAt: null,
  updatedByEmail: null, envFallback: { name: 'POSTFORME_API_KEY', present: false, last4: null }, source: 'none' };
const filled: PlatformSecretItem = { ...base, configured: true, last4: 'a1b2', revision: 3,
  updatedAt: '2026-10-14T08:00:00.000000Z', updatedByEmail: 'admin@example.test', source: 'admin' };
const fromEnv: PlatformSecretItem = { ...base, envFallback: { name: 'POSTFORME_API_KEY', present: true, last4: 'z9y8' },
  source: 'env' };

function row(item: PlatformSecretItem, extra: Partial<Parameters<typeof PlatformSecretRow>[0]> = {}) {
  return renderToStaticMarkup(createElement(PlatformSecretRow, { item, draft: '', pending: false, notice: null,
    failure: null, onDraft: vi.fn(), onSave: vi.fn(), onClear: vi.fn(), ...extra }));
}

describe('PlatformSecretRow', () => {
  it('shows only the last four characters, who and when, and an empty password field', () => {
    const markup = row(filled);
    expect(markup).toContain('正在使用后台填写的密钥（末 4 位 a1b2）');
    expect(markup).toContain('admin@example.test');
    expect(markup).toMatch(/<input[^>]*type="password"[^>]*value=""/);
    expect(markup).toMatch(/autoComplete="new-password"|autocomplete="new-password"/);
    expect(markup).toContain('替换');
    expect(markup).toContain('清除');
  });

  it('offers save without clear when empty, and blocks submitting a blank key', () => {
    const markup = row(base);
    expect(markup).toContain('未配置');
    expect(markup).not.toContain('>清除<');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('names the environment fallback while the admin slot is empty', () => {
    expect(row(fromEnv)).toContain('正在使用 Vercel 环境变量 POSTFORME_API_KEY（末 4 位 z9y8）');
  });

  it('warns about test windows when replacing OpenRouter', () => {
    const markup = row({ ...filled, slot: 'openrouter', envFallback: null });
    expect(markup).toContain('测试窗口要同步更新');
  });
});

describe('platformSecretsView helpers', () => {
  it('explains what clearing does with and without a fallback', () => {
    expect(clearWarning(fromEnv)).toContain('改用 Vercel 环境变量 POSTFORME_API_KEY');
    expect(clearWarning(filled)).toContain('相关功能会停止');
    expect(sourceLabel({ ...base, slot: 'openrouter', envFallback: null })).toContain('未配置');
  });

  it('maps server errors to plain messages without raw details', () => {
    expect(platformSecretError({ data: { code: 'CONFLICT' } }, 'save')).toContain('其他管理员');
    expect(platformSecretError({ data: { code: 'FORBIDDEN' } }, 'clear')).toContain('无权');
    expect(platformSecretError({ data: { code: 'BAD_REQUEST' } }, 'save')).toContain('格式不正确');
    expect(platformSecretError({ data: { code: 'SERVICE_UNAVAILABLE' }, message: 'PLATFORM_SECRET_VAULT_MISSING' }, 'save'))
      .toContain('加密存储没有开启');
    expect(platformSecretError({ data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'raw' }, 'read')).not.toContain('raw');
  });
});

describe('PlatformSecretsSettings', () => {
  it('lists every key from the server read-back', () => {
    trpcState.data = { slots: [filled, { ...base, slot: 'tikhub', envFallback: null }] };
    const markup = renderToStaticMarkup(createElement(PlatformSecretsSettings));
    expect(markup).toContain('第三方密钥');
    expect(markup).toContain('platform-secret-postforme');
    expect(markup).toContain('platform-secret-tikhub');
  });

  it('shows a retry when the status cannot be read', () => {
    trpcState.data = undefined;
    trpcState.error = { data: { code: 'SERVICE_UNAVAILABLE' } };
    expect(renderToStaticMarkup(createElement(PlatformSecretsSettings))).toContain('重新读取');
  });
});
