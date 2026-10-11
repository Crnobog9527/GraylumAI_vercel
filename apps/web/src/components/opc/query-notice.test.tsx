/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryNotice, workspaceErrorMessage } from './query-notice';

it('shows the same not-found notice for another account\'s link and a missing item', () => {
  const foreign = workspaceErrorMessage({ message: 'RUNTIME_SESSION_NOT_FOUND', data: { code: 'NOT_FOUND' } });
  const missing = workspaceErrorMessage({ message: 'anything else', data: { code: 'NOT_FOUND' } });
  expect(foreign).toBe(missing);
  expect(foreign).toContain('找不到这项内容，或你没有查看权限');
  expect(foreign).not.toContain('RUNTIME_');
  const html = renderToStaticMarkup(<QueryNotice error={{ data: { code: 'NOT_FOUND' } }} label="当前工作" retry={() => undefined} />);
  expect(html).toContain('当前工作：找不到这项内容');
  expect(html).not.toContain('读取失败');
});

it('keeps the generic read failure with its diagnostic for real server errors', () => {
  const message = workspaceErrorMessage({ message: '失败（诊断编号：03d122ed-05dc-4808-929f-a17cc09a1cd5）', data: { code: 'INTERNAL_SERVER_ERROR' } });
  expect(message).toBe('读取失败，请重试；现有资料不会因此消失。（诊断编号：03d122ed-05dc-4808-929f-a17cc09a1cd5）');
});
