/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';

/**
 * True while the local edit mode is on (OwnerEditJ marks <html data-owner-editing>): the demos hold still so the
 * Owner can read and edit their text. Never true outside a development server, where the edit mode does not exist.
 */
export function useOwnerEditing() {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setEditing('ownerEditing' in root.dataset);
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-owner-editing'] });
    return () => observer.disconnect();
  }, []);
  return editing;
}
