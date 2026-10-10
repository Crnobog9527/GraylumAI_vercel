/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { LibraryDocument } from '@/hooks/use-library-documents';
import type { UploadItem } from '@/hooks/use-library-uploads';

const { state, mutation } = vi.hoisted(() => ({
  state: { list: {} as Record<string, unknown> },
  mutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
}));
vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ library: { list: { fetch: vi.fn() } } }),
    library: {
      list: { useQuery: () => state.list },
      segments: { useQuery: () => ({ isPending: true }) },
      beginUpload: { useMutation: mutation }, completeUpload: { useMutation: mutation },
      abandonUpload: { useMutation: mutation }, delete: { useMutation: mutation },
      setPurpose: { useMutation: mutation }, download: { useMutation: mutation }, preview: { useMutation: mutation },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { DocumentList, UploadPanel, type UploadPanelProps } from './my-documents-view';
import { DeleteConfirmDialog } from './document-dialogs';
import { MyDocuments } from './my-documents';

const render = (element: ReactElement) => {
  const html = renderToStaticMarkup(element);
  return { html, text: html.replace(/<[^>]*>/g, '') };
};
const doc = (patch: Partial<LibraryDocument> = {}): LibraryDocument => ({
  id: '00000000-0000-4000-8000-000000000001', kind: 'document', format: 'md', purpose: 'authored',
  filename: '我的文章.md', status: 'ready', original_bytes: 1_200, text_bytes: 1_000, content_version: 1,
  created_at: '2026-10-10T00:00:00Z', ...patch,
});
const panel = (patch: Partial<UploadPanelProps> = {}) => render(<UploadPanel uploadEnabled spaceKnown usedBytes={0}
  capacityBytes={50_000_000} uploads={[]} onAdd={vi.fn()} onRetry={vi.fn()} onDismiss={vi.fn()} {...patch}/>);
const list = (documents: LibraryDocument[]) => render(<DocumentList documents={documents} ready onOpen={vi.fn()}
  onDownload={vi.fn()} onDelete={vi.fn()} onPurpose={vi.fn()}/>);

describe('upload panel', () => {
  it('has no upload entry while the server switch is off', () => {
    const { html, text } = panel({ uploadEnabled: false });
    expect(text).toContain('上传暂未开放');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('radiogroup');
  });
  it('asks for a purpose before choosing files when upload is open', () => {
    const { html, text } = panel();
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".txt,.md,.jpg,.jpeg,.png,.webp"');
    expect(text).toContain('我本人写的');
    expect(text).toContain('参考资料');
    expect(text).toContain('先选择用途');
    expect(text).toContain('Word 和 PDF 即将支持');
    expect(text).not.toMatch(/预计|约\s*\d+\s*积分/);
  });
  it('blocks upload when over quota after a downgrade, but explains view/delete still work', () => {
    const { html, text } = panel({ usedBytes: 600_000_000, capacityBytes: 50_000_000 });
    expect(text).toContain('已超出当前会员空间');
    expect(text).toContain('可以查看、下载和删除');
    expect(html).not.toContain('type="file"');
  });
  it('blocks upload when less than 10 MB is free', () => {
    const { html, text } = panel({ usedBytes: 45_000_000 });
    expect(text).toContain('剩余空间不足 10 MB');
    expect(html).not.toContain('type="file"');
  });
  it('shows upload progress, failures with retry, and rejected files', () => {
    const uploads: UploadItem[] = [
      { key: 'a', filename: 'a.txt', purpose: 'authored', status: 'transfer', progress: 0.42 },
      { key: 'b', filename: 'b.png', purpose: 'reference', status: 'failed', progress: 0, message: '剩余空间不足',
        file: new File(['x'], 'b.png') },
      { key: 'c', filename: 'c.pdf', purpose: 'reference', status: 'rejected', progress: 0, message: 'PDF 暂时还不能上传' },
    ];
    const { html, text } = panel({ uploads });
    expect(html).toContain('aria-valuenow="42"');
    expect(text).toContain('上传中 42%');
    expect(text).toContain('上传失败 · 参考资料：剩余空间不足');
    expect(text).toContain('重试');
    expect(text).toContain('不能上传 · 参考资料：PDF 暂时还不能上传');
  });
});

describe('document list', () => {
  it('shows the empty state only after a successful read', () => {
    expect(list([]).text).toContain('还没有文件');
    const loading = render(<DocumentList documents={[]} ready={false} onOpen={vi.fn()} onDownload={vi.fn()}
      onDelete={vi.fn()} onPurpose={vi.fn()}/>);
    expect(loading.text).not.toContain('还没有文件');
  });
  it('offers view, download, purpose change and delete for ready files', () => {
    const { html, text } = list([doc(), doc({ id: '2', kind: 'image', format: 'png', filename: 'p.png', purpose: 'reference' })]);
    expect(text).toContain('查看');
    expect(text).toContain('预览');
    expect(text).toContain('下载');
    expect(text).toContain('删除');
    expect(html).toContain('aria-label="用途 我的文章.md"');
    expect(text).toContain('2.2 KB');
  });
  it('shows deleting files without any read action', () => {
    const { html, text } = list([doc({ status: 'deleting', filename: null, purpose: null, original_bytes: 0, text_bytes: 0 })]);
    expect(text).toContain('已删除的文件');
    expect(text).toContain('删除中，空间暂未释放');
    expect(text).not.toMatch(/查看|下载/);
    expect(html).not.toContain('>删除</button>');
  });
  it('renders hostile file names as text only', () => {
    const { html } = list([doc({ filename: '<img src=x onerror=alert(1)>.md' })]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.md');
  });
});

it('delete confirmation explains the impact and shows the deleting state', () => {
  const idle = render(<DeleteConfirmDialog doc={doc()} pending={false} error="" onConfirm={vi.fn()} onClose={vi.fn()}/>);
  expect(idle.text).toContain('删除「我的文章.md」？');
  expect(idle.text).toContain('60 秒');
  expect(idle.text).toContain('没有回收站');
  expect(idle.text).toContain('不会跟着删除');
  expect(idle.text).toContain('确认删除');
  const pending = render(<DeleteConfirmDialog doc={doc()} pending error="" onConfirm={vi.fn()} onClose={vi.fn()}/>);
  expect(pending.text).toContain('删除中…');
  expect(pending.html).toMatch(/disabled="">删除中…/);
});

describe('my documents container', () => {
  beforeEach(() => {
    state.list = { isSuccess: true, isPending: false, error: null, refetch: vi.fn(),
      data: { usedBytes: 2_200, capacityBytes: 50_000_000, documents: [doc()] } };
  });
  it('stays closed when the list does not report the upload switch as on', () => {
    const { html, text } = render(<MyDocuments/>);
    expect(text).toContain('上传暂未开放');
    expect(html).not.toContain('type="file"');
    expect(text).toContain('我的文章.md');
    expect(text).toContain('已用 2.2 KB / 共 50 MB');
  });
  it('opens upload when the server reports uploadEnabled', () => {
    state.list = { ...state.list, data: { ...(state.list.data as object), uploadEnabled: true } };
    expect(render(<MyDocuments/>).html).toContain('type="file"');
  });
  it('shows a read failure without claiming the library is empty', () => {
    state.list = { isSuccess: false, isPending: false, error: { message: 'LIBRARY_ACCOUNT_CLOSED' }, data: undefined, refetch: vi.fn() };
    const { text } = render(<MyDocuments/>);
    expect(text).toContain('账号当前不可用');
    expect(text).not.toContain('还没有文件');
    expect(text).toContain('已用 — / 共 —');
  });
});
