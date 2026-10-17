/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpacePanel, UploadPanel } from '@/components/library/my-documents-view';
import { JuryReader } from '@/components/landing/preview-jury/JuryReader';
import { FeatureDemo } from '@/components/public-site/features/FeatureDemo';
import { FEATURES } from '@/lib/seo/content/features';
import { AsDemo, DisplayHeading } from './display-heading';
import { PositioningHeader, PositioningResultPanel } from './positioning-chrome';
import { RuntimeHeader } from './runtime-messages';
import * as jury from './fixtures/jury';
import * as library from './fixtures/library';

const noop = () => undefined;
const HEADING_TAG = /<h[1-6][\s>]/;

describe('DisplayHeading', () => {
  it('is the real heading in the product and a plain element inside an example', () => {
    expect(renderToStaticMarkup(<DisplayHeading as="h3" id="x" className="c">标题</DisplayHeading>)).toBe('<h3 id="x" class="c">标题</h3>');
    expect(renderToStaticMarkup(<AsDemo><DisplayHeading as="h3" id="x" className="c">标题</DisplayHeading></AsDemo>))
      .toBe('<div data-demo-heading="h3" id="x" class="c">标题</div>');
  });

  it('keeps the product screens exactly as before: the real heading tags are still there outside an example', () => {
    const html = renderToStaticMarkup(<>
      <PositioningHeader title="我的定位分析" status="进行中" />
      <PositioningResultPanel subtitle="副标题"><p>x</p></PositioningResultPanel>
      <RuntimeHeader title="三分钟学会做司康" />
      <UploadPanel uploadEnabled spaceKnown {...library.SAMPLE_LIBRARY_SPACE} uploads={[]} onAdd={noop} onRetry={noop} onDismiss={noop} />
      <SpacePanel {...library.SAMPLE_LIBRARY_SPACE} />
      <JuryReader detail={jury.SAMPLE_JURY_SCENARIO.detail} names={jury.SAMPLE_JURY_NAMES}
        source={jury.SAMPLE_JURY_READER_SOURCE} actions={jury.SAMPLE_JURY_ADOPT_ACTIONS} />
    </>);
    for (const text of ['<h1>我的定位分析</h1>', '<h2>定位清单</h2>', '<h1>三分钟学会做司康</h1>', '<h2>上传文件</h2>', '<h2>空间使用</h2>']) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/<h2[^>]*id="jury-glance-title"/);
    expect(html).not.toContain('data-demo-heading');
  });
});

describe.each(FEATURES.map(entry => [entry.slug] as const))('feature page demo %s', slug => {
  it('puts no heading tag (h1–h6) into the page through the embedded product screens', () => {
    const html = renderToStaticMarkup(<AsDemo><FeatureDemo slug={slug} /></AsDemo>);
    expect(html).not.toMatch(HEADING_TAG);
  });
});
