/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './h.module.css';

/*
 * The voice wall's "show the rest" button. The server HTML lists every card; once mounted this folds the list
 * (`data-folded` on it, which only hides cards on a phone, see h.module.css) and shows the button. One press
 * unfolds it for good. Without JavaScript nothing is folded and the button never shows.
 */
export function WallMoreH({ listId, hiddenCount }: { listId: string; hiddenCount: number }) {
  const [folded, setFolded] = useState(false);

  useEffect(() => {
    const list = document.getElementById(listId);
    if (!list) return;
    list.dataset.folded = '';
    setFolded(true);
  }, [listId]);

  if (!folded) return null;
  const unfold = () => {
    const list = document.getElementById(listId);
    if (list) delete list.dataset.folded;
    setFolded(false);
  };
  return (
    <button type="button" className={styles.wallMore} aria-controls={listId} aria-expanded="false" onClick={unfold}>
      看另外 {hiddenCount} 条<ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}
