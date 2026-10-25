/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Camera } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

/**
 * Avatar on the profile header. Changing it is not supported: only the nickname is user-writable (S1-FIX, 0144),
 * and /api/upload stores ticket attachments, so nothing is uploaded from here.
 */
export function ProfileAvatar({ src, initial }: { src?: string | null; initial: string }) {
  return (
    <div className="relative group" title="暂不支持更换头像">
      <Avatar className="h-20 w-20" style={{ border: '2px solid rgba(255, 215, 0, 0.3)' }}>
        <AvatarImage src={src ?? undefined} />
        <AvatarFallback
          className="text-2xl font-medium"
          style={{ background: 'rgba(255, 215, 0, 0.1)', color: 'var(--color-primary)' }}
        >
          {initial}
        </AvatarFallback>
      </Avatar>
      <button
        type="button"
        disabled
        aria-label="暂不支持更换头像"
        className="absolute inset-0 grid place-items-center rounded-full opacity-0 focus-visible:opacity-100
          group-hover:opacity-100 transition-opacity cursor-not-allowed"
        style={{ background: 'rgba(0,0,0,0.6)' }}
      >
        <span className="flex flex-col items-center gap-1 text-white">
          <Camera className="h-5 w-5" aria-hidden />
          <span className="text-[10px] leading-tight">暂不支持<br />更换头像</span>
        </span>
      </button>
    </div>
  );
}
