/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ runtimeRateLimits: { get: { setData: vi.fn(), invalidate: vi.fn() } } }),
    runtimeRateLimits: {
      get: { useQuery: () => ({ data: { config: { stopNewCalls: false } }, error: null, refetch: vi.fn() }) },
      setStopNewCalls: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

import { SettingsLoadFailure } from './SettingsLoadFailure';

describe('settings load failure', () => {
  it('still offers the emergency stop when the settings dashboard cannot load', () => {
    const markup = renderToStaticMarkup(createElement(SettingsLoadFailure, {
      error: new Error('读取系统设置失败，请稍后重试'), onRetry: vi.fn(),
    }));
    expect(markup).toContain('读取系统设置失败，请稍后重试');
    expect(markup).toContain('紧急停止新的模型调用');
    expect(markup).toContain('当前状态：正常运行');
    expect(markup).toContain('停止新调用');
  });
});
