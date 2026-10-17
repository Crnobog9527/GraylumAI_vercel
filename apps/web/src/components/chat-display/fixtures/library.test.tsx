/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentList, SpacePanel, UploadPanel } from '@/components/library/my-documents-view';
import * as L from './library';

const noop = () => undefined;

// The landing page renders the shared fixtures like this: they must stay renderable without any query.
it('renders the library page parts from the shared fixtures', () => {
  const html = renderToStaticMarkup(<>
    <UploadPanel uploadEnabled spaceKnown {...L.SAMPLE_LIBRARY_SPACE} uploads={L.SAMPLE_LIBRARY_UPLOADS}
      onAdd={noop} onRetry={noop} onDismiss={noop}/>
    <SpacePanel {...L.SAMPLE_LIBRARY_SPACE}/>
    <DocumentList documents={L.SAMPLE_LIBRARY_DOCUMENTS} ready onOpen={noop} onDownload={noop} onDelete={noop} onPurpose={noop}/>
  </>);
  for (const text of ['品牌介绍.pdf', '可用', '处理中', '上传失败', '店铺门头.png', '预览', '新品介绍.pdf', '上传中 42%', '空间使用'])
    expect(html).toContain(text);
});
