import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({
  trpc: {},
}));

import { AdminSettingsLoadError } from './page';

describe('AdminSettingsPage load failure', () => {
  it('renders an explicit retryable error instead of default settings or an empty plan list', () => {
    const markup = renderToStaticMarkup(createElement(AdminSettingsLoadError, {
      error: new Error('读取系统设置失败，请稍后重试'),
      onRetry: vi.fn(),
    }));

    expect(markup).toContain('加载错误');
    expect(markup).toContain('读取系统设置失败，请稍后重试');
    expect(markup).toContain('重试');
    expect(markup).not.toContain('新用户赠送积分');
    expect(markup).not.toContain('暂无会员方案');
  });
});
