/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { LibraryDocument } from '@/hooks/use-library-documents';
import { holdsServerRow, type UploadItem } from '@/hooks/use-library-uploads';

const { state, mutation } = vi.hoisted(() => ({
  state: {
    list: {} as Record<string, unknown>,
    directory: { isPending: true } as Record<string, unknown>,
    segments: { isPending: true } as Record<string, unknown>,
    segmentInputs: [] as unknown[],
  },
  mutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
}));
vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ library: { list: { fetch: vi.fn() } } }),
    library: {
      list: { useQuery: () => state.list },
      directory: { useQuery: () => state.directory },
      segments: { useQuery: (input: unknown) => { state.segmentInputs.push(input); return state.segments; } },
      beginUpload: { useMutation: mutation }, completeUpload: { useMutation: mutation },
      beginWordUpload: { useMutation: mutation }, beginWordTextUpload: { useMutation: mutation },
      completeWordUpload: { useMutation: mutation },
      abandonUpload: { useMutation: mutation }, delete: { useMutation: mutation },
      setPurpose: { useMutation: mutation }, download: { useMutation: mutation }, preview: { useMutation: mutation },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { DocumentList, UploadPanel, type UploadPanelProps } from './my-documents-view';
import { DeleteConfirmDialog } from './document-dialogs';
import { MyDocuments } from './my-documents';
import { chaptersOf, DocumentReader } from './document-reader';
import { mergePages } from '@/hooks/use-library-documents';

afterEach(() => vi.unstubAllEnvs());

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
  it('opens Word only with the extraction flag, with the browser-reading note and no credit estimate', () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', 'true');
    const { html, text } = panel();
    expect(html).toContain('accept=".txt,.md,.jpg,.jpeg,.png,.webp,.docx"');
    expect(text).toContain('Word（.docx）');
    expect(text).toContain('PDF 即将支持');
    expect(text).not.toContain('Word 和 PDF 即将支持');
    expect(text).toContain('在你自己的浏览器里读取，不扣积分');
    expect(text).not.toMatch(/预计|约\s*\d+\s*积分/);
  });
  it('shows the Word reading and removing states without action buttons', () => {
    const { html, text } = panel({ uploads: [
      { key: 'w', filename: 'w.docx', purpose: 'authored', status: 'extract', progress: 0 },
      { key: 'r', filename: 'r.txt', purpose: 'authored', status: 'removing', progress: 0, file: new File(['x'], 'r.txt') },
    ] });
    expect(text).toContain('正在本机读取 Word 内容…');
    expect(text).toContain('正在移除…');
    expect(text).not.toContain('重试');
    expect(html).not.toContain('>移除</button>');
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
  it('offers "load more" only while the server returns a next cursor', () => {
    expect(render(<MyDocuments/>).text).not.toContain('加载更多');
    state.list = { ...state.list, data: { ...(state.list.data as object),
      nextCursor: { createdAt: '2026-10-10T00:00:00.123456+00:00', id: doc().id } } };
    expect(render(<MyDocuments/>).text).toContain('加载更多');
  });
  it('shows a read failure without claiming the library is empty', () => {
    state.list = { isSuccess: false, isPending: false, error: { message: 'LIBRARY_ACCOUNT_CLOSED' }, data: undefined, refetch: vi.fn() };
    const { text } = render(<MyDocuments/>);
    expect(text).toContain('账号当前不可用');
    expect(text).not.toContain('还没有文件');
    expect(text).toContain('已用 — / 共 —');
  });
});

describe('paging order', () => {
  it('keeps the server order across pages and drops repeats, never re-sorting', () => {
    const a = doc({ id: 'a', created_at: '2026-10-10T00:00:03Z' });
    const b = doc({ id: 'b', created_at: '2026-10-10T00:00:02Z' });
    const c = doc({ id: 'c', created_at: '2026-10-10T00:00:09Z' });
    expect(mergePages([{ documents: [a, b] }, { documents: [b, c] }]).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('document reader', () => {
  beforeEach(() => { state.segmentInputs = []; });
  it('builds one directory entry per heading', () => {
    expect(chaptersOf([{ ordinal: 0, title: '' }, { ordinal: 1, title: '一' }, { ordinal: 2, title: '一' }, { ordinal: 3, title: '二' }]))
      .toEqual([{ ordinal: 1, title: '一' }, { ordinal: 3, title: '二' }]);
  });
  it('shows the whole directory and reads a range of segments', () => {
    state.directory = { isPending: false, data: [
      { ordinal: 0, title: '第一章' }, { ordinal: 1, title: '第一章' }, { ordinal: 2, title: '<b>第二章</b>' },
    ] };
    state.segments = { isPending: false, data: [
      { ordinal: 0, title: '第一章', body: '甲' }, { ordinal: 1, title: '第一章', body: '乙' }, { ordinal: 2, title: '<b>第二章</b>', body: '丙' },
    ] };
    const { html, text } = render(<DocumentReader doc={doc()}/>);
    expect(state.segmentInputs[0]).toMatchObject({ documentId: doc().id, version: 1, start: 0, count: 5 });
    expect(html).toContain('aria-label="目录"');
    expect(text).toContain('第 1–3 段，共 3 段 · 第一章');
    expect(text).toContain('已到最后');
    expect(html.match(/<h4>/g)).toHaveLength(2);
    expect(html).toContain('&lt;b&gt;第二章&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });
  it('never shows an earlier range under a newly selected one while it loads', () => {
    state.directory = { isPending: false, data: [{ ordinal: 0, title: '一' }, { ordinal: 1, title: '二' }] };
    state.segments = { isPending: true, data: undefined };
    const { html, text } = render(<DocumentReader doc={doc()}/>);
    expect(html).toContain('aria-label="目录"');
    expect(text).toContain('正在读取内容…');
    expect(html).not.toContain('<section');
  });
  it('hides the directory when the document has no headings, and reports read errors', () => {
    state.directory = { isPending: false, data: [{ ordinal: 0, title: '' }] };
    state.segments = { isPending: false, data: [{ ordinal: 0, title: '', body: '纯文字' }] };
    expect(render(<DocumentReader doc={doc()}/>).html).not.toContain('aria-label="目录"');
    state.directory = { isPending: false, error: { message: 'LIBRARY_VERSION_CHANGED' } };
    expect(render(<DocumentReader doc={doc()}/>).text).toContain('文件内容已更新');
  });
});

it('counts failed items that still owe the server a release or re-check as unsettled', () => {
  const item = (patch: Partial<UploadItem>): UploadItem => ({ key: 'k', filename: 'a.txt', purpose: 'authored', status: 'failed', progress: 0, ...patch });
  expect(holdsServerRow(item({ attempt: { requestId: 'r', resume: 'begin', releaseFirst: 'old' } }))).toBe(true);
  expect(holdsServerRow(item({ attempt: { requestId: 'r', resume: 'complete', documentId: 'd' } }))).toBe(true);
  expect(holdsServerRow(item({ attempt: { requestId: 'r', resume: 'text', documentId: 'd' } }))).toBe(true);
  expect(holdsServerRow(item({ attempt: { requestId: 'r', resume: 'begin' } }))).toBe(false);
  expect(holdsServerRow(item({ status: 'rejected' }))).toBe(false);
});
