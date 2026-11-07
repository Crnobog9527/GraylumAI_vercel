/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { openConsentPreferences } from '@/lib/analytics/consent';

const LABELS = {
  'zh-Hans': 'Cookie 设置',
  'zh-TW': 'Cookie 設定',
} as const;

/**
 * The footer's "Cookie 设置" (ANALYTICS-CONSENT): reopens the statistics consent bar in every region, so a visitor can
 * accept, or turn statistics off, at any time.
 */
export function ConsentPreferenceLinks({ locale = 'zh-Hans', className }: { locale?: keyof typeof LABELS; className?: string }) {
  return (
    <li>
      <button type="button" className={className} onClick={() => { openConsentPreferences(); }}>
        {LABELS[locale]}
      </button>
    </li>
  );
}
