'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { MAX_COVER_MS } from '@/lib/publish-monitor/publish-flow';
import { MAX_MEDIA_BYTES, MAX_MEDIA_FILES } from '@/lib/publish-monitor/upload-media';
import styles from './publish.module.css';

/**
 * Picks the files of one post. Files stay in this browser (preview only) until the user confirms publishing; a video
 * can get a cover frame (thumbnail_timestamp_ms), otherwise the platform picks its own.
 */
export type PickedMedia = { key: string; file: File; coverMs: number | null };

const MEDIA = /^(image|video)\//;
const sizeLabel = (bytes: number) => bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

function Preview({ item, disabled, lockCover, onCover }: { item: PickedMedia; disabled: boolean; lockCover: boolean;
  onCover: (ms: number | null) => void }) {
  const url = useMemo(() => URL.createObjectURL(item.file), [item.file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [duration, setDuration] = useState(0);
  const video = item.file.type.startsWith('video/');
  const seconds = (item.coverMs ?? 0) / 1000;
  return (
    <>
      {video
        ? <video src={`${url}#t=${seconds}`} muted playsInline preload="metadata"
          onLoadedMetadata={event => setDuration(event.currentTarget.duration || 0)} aria-label={`${item.file.name} 预览`} />
        : <img src={url} alt={item.file.name} />}
      <div className={styles.fileMeta}>
        <p>{item.file.name}</p>
        <p>{sizeLabel(item.file.size)}</p>
        {video && duration > 0 && (
          <label className={styles.cover}>
            封面：{item.coverMs === null ? '平台默认' : `第 ${seconds.toFixed(1)} 秒`}
            <input type="range" min={0} max={Math.min(Math.floor(duration * 1000), MAX_COVER_MS)} step={100} disabled={disabled || lockCover}
              value={item.coverMs ?? 0} aria-label="选择封面时间点" onChange={event => onCover(Number(event.target.value))} />
            {item.coverMs !== null && <button type="button" disabled={disabled || lockCover}
              onClick={() => onCover(null)}>用平台默认</button>}
          </label>
        )}
      </div>
    </>
  );
}

export function MediaPicker({ items, onChange, disabled, lockCover = false }: { items: PickedMedia[];
  onChange: (items: PickedMedia[]) => void; disabled: boolean; lockCover?: boolean }) {
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const full = items.length >= MAX_MEDIA_FILES;
  const closed = disabled || full;
  function add(list: FileList | null) {
    setError('');
    const files = Array.from(list ?? []);
    if (files.some(file => !MEDIA.test(file.type))) return setError('只能选择图片或视频文件。');
    if (files.some(file => file.size < 1 || file.size > MAX_MEDIA_BYTES)) return setError('单个文件不能超过 1GB。');
    if (items.length + files.length > MAX_MEDIA_FILES) return setError(`每次最多 ${MAX_MEDIA_FILES} 个文件。`);
    onChange([...items, ...files.map(file => ({ key: crypto.randomUUID(), file, coverMs: null }))]);
  }
  return (
    <div>
      {/* The file input covers the whole area (it is the control; the words are its visible face), so a click, the
          keyboard and a dropped file all go through the same checks in add(). */}
      <label className={styles.drop} data-over={over} data-disabled={closed}
        onDragOver={event => { if (!closed) { event.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={event => { event.preventDefault(); setOver(false); if (!closed) add(event.dataTransfer.files); }}>
        {/* A phone has nothing to drag: it says what a tap opens (the photo library or files). */}
        {full ? `已选满 ${MAX_MEDIA_FILES} 个文件` : <>
          <span className={styles.dropDesk}>把文件拖到这里，或<strong>选择文件</strong></span>
          <span className={styles.dropPhone}><strong>从相册或文件里选择</strong></span>
        </>}
        <small>文件只在你的浏览器里预览，点"确认发布"之前不会上传到任何地方。</small>
        <input type="file" accept="image/*,video/*" multiple disabled={closed}
          aria-label="选择要发布的图片或视频" onChange={event => { add(event.target.files); event.target.value = ''; }} />
      </label>
      {error && <p role="alert" className={`${styles.error} ${styles.stack}`}>{error}</p>}
      {items.length > 0 && (
        <ul className={styles.files}>
          {items.map(item => (
            <li key={item.key} className={styles.fileRow}>
              <Preview item={item} disabled={disabled} lockCover={lockCover}
                onCover={ms => onChange(items.map(i => i.key === item.key ? { ...i, coverMs: ms } : i))} />
              <button type="button" className={styles.remove} aria-label={`移除 ${item.file.name}`} disabled={disabled}
                onClick={() => onChange(items.filter(i => i.key !== item.key))}><X className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
