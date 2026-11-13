'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Columns3 } from 'lucide-react';
import { useRailGoldTools } from '@/components/opc/rail-gold-tools';
import styles from './compare.module.css';

/**
 * "多模型对比" in the message box's row of tools, on a phone only (Owner 2026-11-12, phone plan A, screens A3 and C2). A phone's
 * conversation page fills the screen and has no rail, so the rail's entry is not there to press; on a computer the entry stays
 * in the rail and this draws nothing (compare.module.css). It is the same entry, not a second rule: what pressing it does, and
 * whether it shows at all, is the rail's own answer (rail-gold-tools.tsx): hidden while the tool is off for the whole site,
 * the picker for a plan that has it, the tool's paywall otherwise.
 */
export function ComparePhoneEntry() {
  // Only used from pages that hold the message box, so there is always a host to ask; nothing to open elsewhere.
  const tools = useRailGoldTools({ navigate: () => undefined });
  if (!tools.onCompare) return null;
  return <>
    <button type="button" className={styles.phoneEntry} onClick={tools.onCompare}>
      <Columns3 size={15} strokeWidth={1.7} aria-hidden="true" />多模型对比</button>
    {tools.dialogs}
  </>;
}
