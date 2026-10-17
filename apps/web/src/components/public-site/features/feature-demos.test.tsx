/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ArticlePage } from '@/components/public-site/ArticlePage';
import { FEATURES } from '@/lib/seo/content/features';
import * as library from '@/components/chat-display/fixtures/library';
import * as positioning from '@/components/chat-display/fixtures/positioning';
import * as runtime from '@/components/chat-display/fixtures/runtime';
import { FeatureDemo } from './FeatureDemo';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

// Every feature page shows the product's own components with the shared example data (nothing redrawn).
const EXPECTED: Record<string, string[]> = {
  positioning: [positioning.SAMPLE_POSITIONING_HEADER.title, '定位清单', positioning.SAMPLE_QUESTION_CARD.question, '最终目标与变现方式'],
  content: [runtime.SAMPLE_RUNTIME_HEADER.title, '建议稿', '正文稿件'],
  library: [library.SAMPLE_LIBRARY_DOCUMENTS[0].filename ?? '', '空间使用'],
  jury: ['示例评审'],
};

describe.each(FEATURES.map(entry => [entry.slug, entry] as const))('feature demo %s', (slug, entry) => {
  it('renders the real components with the example data inside the article page', () => {
    const html = renderToStaticMarkup(<ArticlePage content={entry.content} demo={<FeatureDemo slug={entry.slug} />} />);
    for (const text of EXPECTED[slug]) expect(html).toContain(text);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('says AI 教练, never 导师, in the page text', () => {
    expect(JSON.stringify(entry.content)).not.toContain('导师');
  });
});
