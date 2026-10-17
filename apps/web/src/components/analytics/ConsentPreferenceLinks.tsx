/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ANALYTICS_CONFIG } from '@/lib/analytics/config';
import { openConsentPreferences } from '@/lib/analytics/consent';

const LABELS = {
  'zh-Hans': { settings: 'Cookie 设置', doNotSell: '不要出售或分享我的个人信息' },
  'zh-TW': { settings: 'Cookie 設定', doNotSell: '請勿出售或分享我的個人資訊' },
} as const;

/**
 * Footer entries to Termly's preference centre (ANALYTICS plan §3.4, §7 PR-1): change or withdraw consent,
 * and the US "do not sell or share" entry. Both open the same Termly dialog; nothing shows without Termly.
 */
export function ConsentPreferenceLinks({ locale = 'zh-Hans', className }: { locale?: keyof typeof LABELS; className?: string }) {
  if (!ANALYTICS_CONFIG.termlyWebsiteUuid) return null;
  const labels = LABELS[locale];
  return (
    <>
      {[labels.settings, labels.doNotSell].map(label => (
        <li key={label}>
          <button type="button" className={className}
            onClick={() => { openConsentPreferences(); }}>
            {label}
          </button>
        </li>
      ))}
    </>
  );
}
