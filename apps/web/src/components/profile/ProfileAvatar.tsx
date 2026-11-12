/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useRef, useState, type ChangeEvent } from 'react';
import { Camera } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { uploadAvatar } from '@/lib/profile-avatar/upload';
import { trpc } from '@/trpc/client';

/**
 * Avatar on the profile header (PROFILE-AVATAR, Owner 2026-11-12). Clicking it picks a JPG/PNG/WebP image, which is
 * cropped to a square and compressed in the browser and saved through /api/profile/avatar (own avatar only).
 */
export function ProfileAvatar({ src, initial, onChanged }: {
  src?: string | null; initial: string; onChanged?: (avatarUrl: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const utils = trpc.useUtils();

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    setBusy(true); setMessage(null);
    const result = await uploadAvatar(file);
    setBusy(false);
    if (!result.ok) { setMessage({ tone: 'error', text: result.message }); return; }
    setMessage({ tone: 'success', text: '头像已更新' });
    onChanged?.(result.avatarUrl);
    // The rail and the account popover read the same profile query.
    void utils.user.getUserProfile.invalidate();
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative group">
        <Avatar className="h-20 w-20" style={{ border: '2px solid var(--border-secondary)' }}>
          <AvatarImage src={src || undefined} alt="" className="object-cover" />
          <AvatarFallback className="text-2xl font-medium" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
            {initial}
          </AvatarFallback>
        </Avatar>
        <button
          type="button"
          disabled={busy}
          aria-label={busy ? '头像上传中' : '更换头像'}
          title="更换头像"
          onClick={() => input.current?.click()}
          className={`absolute inset-0 grid place-items-center rounded-full transition-opacity focus-visible:opacity-100
            group-hover:opacity-100 ${busy ? 'opacity-100 cursor-wait' : 'opacity-0 cursor-pointer'}`}
          style={{ background: 'rgba(0,0,0,0.55)' }}
        >
          <span className="flex flex-col items-center gap-1 text-white">
            <Camera className="h-5 w-5" aria-hidden />
            <span className="text-[10px] leading-tight">{busy ? '上传中…' : '更换头像'}</span>
          </span>
        </button>
        {/* Touch screens have no hover: a small camera badge says the avatar can be changed. */}
        <span aria-hidden className="pointer-events-none absolute -bottom-0.5 -right-0.5 grid h-6 w-6 place-items-center rounded-full"
          style={{ background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-secondary)', color: 'var(--text-secondary)' }}>
          <Camera className="h-3.5 w-3.5" />
        </span>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1}
          aria-hidden onChange={choose} />
      </div>
      {message && (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className="max-w-[10rem] text-center text-xs"
          style={{ color: message.tone === 'error' ? 'var(--color-error, #d92d20)' : 'var(--text-secondary)' }}>
          {message.text}
        </p>
      )}
    </div>
  );
}
