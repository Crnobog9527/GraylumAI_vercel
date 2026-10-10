'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { FileText, Image as ImageIcon, Upload } from 'lucide-react';
import type { LibraryDocument } from '@/hooks/use-library-documents';
import type { UploadItem } from '@/hooks/use-library-uploads';
import {
  isWordUploadReady, formatBytes, libraryAccept, PURPOSE_LABEL, spaceState, supportedText, type LibraryPurpose,
} from '@/lib/library-documents/format';
import styles from './my-documents.module.css';

const STATUS_LABEL: Record<LibraryDocument['status'], string> = {
  uploading: '上传未完成', processing: '处理中', ready: '可用', failed: '上传失败', deleting: '删除中，空间暂未释放',
};
const QUEUE_LABEL: Record<UploadItem['status'], string> = {
  waiting: '等待上传', extract: '正在本机读取 Word 内容…', begin: '准备上传…', transfer: '上传中', complete: '正在核对文件…',
  failed: '上传失败', removing: '正在移除…', rejected: '不能上传', done: '已上传',
};

export type UploadPanelProps = {
  uploadEnabled: boolean; spaceKnown: boolean; usedBytes?: number; capacityBytes?: number;
  uploads: UploadItem[]; onAdd: (files: File[], purpose: LibraryPurpose) => void;
  onRetry: (key: string) => void; onDismiss: (key: string) => void | Promise<void>;
};

export function UploadPanel(props: UploadPanelProps) {
  const [purpose, setPurpose] = useState<LibraryPurpose | null>(null);
  const space = props.spaceKnown ? spaceState(props.usedBytes ?? 0, props.capacityBytes ?? 0) : null;
  const blocked = !props.uploadEnabled || space === null || space !== 'ok';
  return <section className={styles.panel} aria-label="上传文件">
    <h2>上传文件</h2>
    <p className={styles.hint}>
      支持{supportedText()}，单个文件不超过 10 MB。{isWordUploadReady() ? 'PDF 即将支持。' : 'Word 和 PDF 即将支持。'}
    </p>
    {isWordUploadReady() && <p className={styles.hint}>
      Word 的文字在你自己的浏览器里读取，不扣积分；文中的图片暂不识别。
    </p>}
    {!props.uploadEnabled && <p className={styles.closed} role="status">
      上传暂未开放。已上传的文件仍可查看、下载和删除。
    </p>}
    {props.uploadEnabled && space === 'over' && <p className={styles.warn} role="status">
      已超出当前会员空间：已有文件不会删除，可以查看、下载和删除，但不能上传新文件。删除部分文件或升级会员后可继续上传。
    </p>}
    {props.uploadEnabled && space === 'low' && <p className={styles.warn} role="status">
      剩余空间不足 10 MB，暂时不能上传。删除部分文件或升级会员后可继续上传。
    </p>}
    {!blocked && <>
      <div className={styles.purposes} role="radiogroup" aria-label="文件用途">
        {(Object.keys(PURPOSE_LABEL) as LibraryPurpose[]).map((value) => <label key={value}>
          <input type="radio" name="library-purpose" value={value} checked={purpose === value}
            onChange={() => setPurpose(value)}/>
          {PURPOSE_LABEL[value]}
        </label>)}
      </div>
      <label className={styles.pick} aria-disabled={!purpose}>
        <Upload size={15}/>{purpose ? '选择文件' : '先选择用途'}
        <input type="file" multiple accept={libraryAccept()} disabled={!purpose} aria-label="选择要上传的文件"
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            if (purpose && files.length) props.onAdd(files, purpose);
          }}/>
      </label>
      <p className={styles.hint}>「我本人写的」是你自己写的作品（语料库）；「参考资料」是收集来参考的内容。用途以后可以修改。</p>
    </>}
    {!!props.uploads.length && <ul className={styles.queue} aria-label="上传进度">
      {props.uploads.map((item) => <li key={item.key} className={styles.queueItem} data-status={item.status}>
        <strong>{item.filename}</strong>
        <span>
          {item.status === 'failed' && item.file && <button type="button" className={styles.linkButton}
            onClick={() => props.onRetry(item.key)}>重试</button>}
          {['failed', 'rejected', 'done'].includes(item.status) && <button type="button" className={styles.linkButton}
            onClick={() => { void props.onDismiss(item.key); }}>移除</button>}
        </span>
        {item.status === 'transfer' && <div className={styles.progress} role="progressbar" aria-label={item.filename + ' 上传进度'}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
          <span style={{ width: Math.round(item.progress * 100) + '%' }}/>
        </div>}
        <small>
          {QUEUE_LABEL[item.status]}{item.status === 'transfer' ? ' ' + Math.round(item.progress * 100) + '%' : ''}
          {' · '}{PURPOSE_LABEL[item.purpose]}{item.message ? '：' + item.message : ''}
        </small>
      </li>)}
    </ul>}
  </section>;
}

export function SpacePanel({ usedBytes, capacityBytes }: { usedBytes?: number; capacityBytes?: number }) {
  const known = typeof usedBytes === 'number' && typeof capacityBytes === 'number';
  const state = known ? spaceState(usedBytes, capacityBytes) : 'ok';
  const percent = known && capacityBytes > 0 ? Math.min(100, Math.round((usedBytes / capacityBytes) * 100)) : 0;
  return <section className={styles.panel} aria-label="空间使用">
    <h2>空间使用</h2>
    <div className={styles.meter} data-state={state}><span style={{ width: percent + '%' }}/></div>
    <p className={styles.spaceText}>
      {known ? `已用 ${formatBytes(usedBytes)} / 共 ${formatBytes(capacityBytes)}` : '已用 — / 共 —'}
    </p>
    <p className={styles.hint}>原文件和提取出的文字都计入空间；正在上传或删除中的文件会暂时多占一些空间。</p>
  </section>;
}

type Filter = 'all' | LibraryPurpose;
export type DocumentListProps = {
  documents: LibraryDocument[]; ready: boolean;
  onOpen: (doc: LibraryDocument) => void; onDownload: (doc: LibraryDocument) => void;
  onDelete: (doc: LibraryDocument) => void; onPurpose: (doc: LibraryDocument, purpose: LibraryPurpose) => void;
  busyId?: string | null;
};

export function DocumentList(props: DocumentListProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = props.documents.filter((doc) => filter === 'all' || doc.purpose === filter);
  return <section aria-label="文档列表">
    <div className={styles.filters} role="group" aria-label="按用途筛选">
      {([['all', '全部'], ['authored', PURPOSE_LABEL.authored], ['reference', PURPOSE_LABEL.reference]] as const)
        .map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key}
          onClick={() => setFilter(key)}>{label}</button>)}
    </div>
    <div className={styles.table}>
      <div className={styles.row + ' ' + styles.head}><span>文件</span><span>用途</span><span>大小</span>
        <span>状态</span><span/></div>
      {rows.map((doc) => <DocumentRow key={doc.id} doc={doc} {...props}/>)}
      {props.ready && !rows.length && <p className={styles.empty}>
        {filter === 'all' ? '还没有文件。上传后会显示在这里。' : '这个分类下还没有文件。'}
      </p>}
    </div>
  </section>;
}

function DocumentRow({ doc, ...props }: DocumentListProps & { doc: LibraryDocument }) {
  const ready = doc.status === 'ready';
  const busy = props.busyId === doc.id;
  const name = doc.filename ?? (doc.status === 'deleting' ? '已删除的文件' : '未命名文件');
  const Icon = doc.kind === 'image' ? ImageIcon : FileText;
  return <div className={styles.row} data-testid="library-document">
    <div className={styles.name}><Icon size={16} aria-hidden/>
      <div style={{ minWidth: 0 }}>
        <span title={name}>{name}</span>
        <small>{doc.status === 'deleting' ? '—' : new Date(doc.created_at).toLocaleDateString('sv-SE')}</small>
      </div>
    </div>
    <div>{ready && doc.purpose
      ? <select aria-label={'用途 ' + name} value={doc.purpose} disabled={busy}
        onChange={(event) => props.onPurpose(doc, event.target.value as LibraryPurpose)}>
        <option value="authored">{PURPOSE_LABEL.authored}</option>
        <option value="reference">{PURPOSE_LABEL.reference}</option>
      </select>
      : <span className={styles.status}>{doc.purpose ? PURPOSE_LABEL[doc.purpose] : '—'}</span>}</div>
    <span>{doc.status === 'deleting' ? '—' : formatBytes(doc.original_bytes + doc.text_bytes)}</span>
    <span className={styles.status} data-status={doc.status}>{STATUS_LABEL[doc.status]}</span>
    <div className={styles.actions}>
      {ready && <button type="button" onClick={() => props.onOpen(doc)}>{doc.kind === 'image' ? '预览' : '查看'}</button>}
      {ready && <button type="button" disabled={busy} onClick={() => props.onDownload(doc)}>下载</button>}
      {doc.status !== 'deleting' && <button type="button" className={styles.danger} disabled={busy}
        onClick={() => props.onDelete(doc)}>删除</button>}
    </div>
  </div>;
}
