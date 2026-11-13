/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState, type CSSProperties } from 'react';

/** PROFILE-AVATAR: the account's own picture where there is one; the initial circle when there is none or it fails
 * to load. The circle's size and colours come from the caller's class. */
export function AccountAvatar({ url, initial, className, style }: { url?: string | null; initial: string; className?: string;
  /** For a circle drawn by the parent (the home page's top bar link): fill it. */ style?: CSSProperties }) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = url && failed !== url ? url : null;
  return <span className={className} style={shown ? { ...style, overflow: 'hidden' } : style}>
    {shown
      ? <img src={shown} alt="" referrerPolicy="no-referrer" onError={() => setFailed(shown)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}/>
      : initial}
  </span>;
}
