/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Button } from '@/components/ui/button';
import { ANALYTICS_CONFIG } from '@/lib/analytics/config';
import { openConsentPreferences } from '@/lib/analytics/consent';

/** In-app entry to Termly's preference centre (ANALYTICS plan §3.4); hidden while Termly is not configured. */
export function CookieSettingsCard() {
  if (!ANALYTICS_CONFIG.termlyWebsiteUuid) return null;
  return (
    <div className="mt-6 rounded-2xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>Cookie 和统计设置</p>
      <p className="mt-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        查看或修改网站统计和广告 Cookie 的选择，也可以在这里选择不出售或分享你的个人信息。
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => { openConsentPreferences(); }}>
        打开 Cookie 设置
      </Button>
    </div>
  );
}
