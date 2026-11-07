/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Button } from '@/components/ui/button';
import { openConsentPreferences } from '@/lib/analytics/consent';

/** In-app entry to the statistics consent choice (ANALYTICS-CONSENT): reopens the consent bar. */
export function CookieSettingsCard() {
  return (
    <div className="mt-6 rounded-2xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>Cookie 和统计设置</p>
      <p className="mt-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        查看或修改网站统计的选择。关闭后，我们不再在这个浏览器里运行统计工具。
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => { openConsentPreferences(); }}>
        打开 Cookie 设置
      </Button>
    </div>
  );
}
