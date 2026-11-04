/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSkeleton } from './workspace-skeleton';

vi.mock('@/components/opc/workspace-frame', () => ({ WorkspaceFrame: ({ area, children }: { area: string; children: unknown }) =>
  <div data-frame={area}>{children as never}</div> }));

describe('WorkspaceSkeleton', () => {
  it('draws the placeholder inside the page frame (light background, sidebar), with no words', () => {
    const html = renderToStaticMarkup(<WorkspaceSkeleton area="topics" label="选题工作空间读取中" />);
    expect(html).toMatch(/^<div data-frame="topics"><main>.*page-skeleton/);
    expect(html).not.toMatch(/正在|加载中|读取中…/);
  });
});
