/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';

/** PROFILE-AVATAR: the account's own picture where there is one; the initial circle when there is none or it fails
 * to load. The circle's size and colours come from the caller's class. */
export function AccountAvatar({ url, initial, className }: { url?: string | null; initial: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = url && failed !== url ? url : null;
  return <span className={className} style={shown ? { overflow: 'hidden' } : undefined}>
    {shown
      ? <img src={shown} alt="" referrerPolicy="no-referrer" onError={() => setFailed(shown)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}/>
      : initial}
  </span>;
}
