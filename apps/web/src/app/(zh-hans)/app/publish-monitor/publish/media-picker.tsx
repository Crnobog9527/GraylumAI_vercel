'use client';

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { MAX_COVER_MS } from '@/lib/publish-monitor/publish-flow';
import { MAX_MEDIA_BYTES, MAX_MEDIA_FILES } from '@/lib/publish-monitor/upload-media';

/**
 * Picks the files of one post. Files stay in this browser (preview only) until the user confirms publishing; a video
 * can get a cover frame (thumbnail_timestamp_ms), otherwise the platform picks its own.
 */
export type PickedMedia = { key: string; file: File; coverMs: number | null };

const MEDIA = /^(image|video)\//;
const sizeLabel = (bytes: number) => bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

function Preview({ item, disabled, onCover }: { item: PickedMedia; disabled: boolean; onCover: (ms: number | null) => void }) {
  const url = useMemo(() => URL.createObjectURL(item.file), [item.file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [duration, setDuration] = useState(0);
  const video = item.file.type.startsWith('video/');
  if (!video) return <img src={url} alt={item.file.name} className="h-24 w-24 rounded object-cover" />;
  const seconds = (item.coverMs ?? 0) / 1000;
  return (
    <div className="space-y-1">
      <video src={`${url}#t=${seconds}`} muted playsInline preload="metadata" className="h-24 rounded bg-black"
        onLoadedMetadata={event => setDuration(event.currentTarget.duration || 0)} aria-label={`${item.file.name} 预览`} />
      {duration > 0 && (
        <label className="block text-xs text-[var(--text-secondary)]">
          封面：{item.coverMs === null ? '平台默认' : `第 ${seconds.toFixed(1)} 秒`}
          <input type="range" min={0} max={Math.min(Math.floor(duration * 1000), MAX_COVER_MS)} step={100} disabled={disabled}
            value={item.coverMs ?? 0} aria-label="选择封面时间点" className="block w-40"
            onChange={event => onCover(Number(event.target.value))} />
          {item.coverMs !== null && <button type="button" className="underline" disabled={disabled}
            onClick={() => onCover(null)}>用平台默认</button>}
        </label>
      )}
    </div>
  );
}

export function MediaPicker({ items, onChange, disabled }: { items: PickedMedia[]; onChange: (items: PickedMedia[]) => void;
  disabled: boolean }) {
  const [error, setError] = useState('');
  function add(list: FileList | null) {
    setError('');
    const files = Array.from(list ?? []);
    if (files.some(file => !MEDIA.test(file.type))) return setError('只能选择图片或视频文件。');
    if (files.some(file => file.size < 1 || file.size > MAX_MEDIA_BYTES)) return setError('单个文件不能超过 1GB。');
    if (items.length + files.length > MAX_MEDIA_FILES) return setError(`每次最多 ${MAX_MEDIA_FILES} 个文件。`);
    onChange([...items, ...files.map(file => ({ key: crypto.randomUUID(), file, coverMs: null }))]);
  }
  return (
    <div className="space-y-2">
      <input type="file" accept="image/*,video/*" multiple disabled={disabled || items.length >= MAX_MEDIA_FILES}
        aria-label="选择要发布的图片或视频" onChange={event => { add(event.target.files); event.target.value = ''; }} />
      <p className="text-xs text-[var(--text-secondary)]">文件只在你的浏览器里预览，点"确认发布"之前不会上传到任何地方。</p>
      {error && <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p>}
      <ul className="flex flex-wrap gap-3">
        {items.map(item => (
          <li key={item.key} className="flex items-start gap-2 rounded border border-[var(--border-default)] p-2">
            <Preview item={item} disabled={disabled}
              onCover={ms => onChange(items.map(i => i.key === item.key ? { ...i, coverMs: ms } : i))} />
            <div className="text-xs">
              <p className="max-w-40 truncate">{item.file.name}</p>
              <p className="text-[var(--text-secondary)]">{sizeLabel(item.file.size)}</p>
            </div>
            <button type="button" aria-label={`移除 ${item.file.name}`} disabled={disabled}
              onClick={() => onChange(items.filter(i => i.key !== item.key))}><X className="h-4 w-4" /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}
