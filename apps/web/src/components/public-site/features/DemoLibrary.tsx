/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { DocumentList, SpacePanel, UploadPanel } from '@/components/library/my-documents-view';
import * as library from '@/components/chat-display/fixtures/library';
import { ProductFrame } from './ProductFrame';

const noop = () => undefined;
const noopAsync = async () => undefined;

/** One feature page's product screen: the product's own display components with the shared example data; every callback is a no-op. */
export function DemoLibrary() {
  return (
    <ProductFrame label="资料库的产品界面示例" caption="示例界面，文件名为虚构的示例数据">
      <div className="space-y-4">
        <UploadPanel uploadEnabled spaceKnown {...library.SAMPLE_LIBRARY_SPACE} uploads={library.SAMPLE_LIBRARY_UPLOADS}
          onAdd={noop} onRetry={noop} onDismiss={noopAsync} />
        <SpacePanel {...library.SAMPLE_LIBRARY_SPACE} />
        <DocumentList documents={library.SAMPLE_LIBRARY_DOCUMENTS} ready onOpen={noop} onDownload={noop} onDelete={noop} onPurpose={noop} />
      </div>
    </ProductFrame>
  );
}
