/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { PublishMonitorQuota } from '@/components/admin/PublishMonitorQuota';
import { PublishMonitorReviewSettings } from '@/components/admin/PublishMonitorReviewSettings';
import { PublishMonitorStuckCleanup } from '@/components/admin/PublishMonitorStuckCleanup';

/** PUBLISH-MONITOR admin: weekly review settings and the Post for Me cleanup that stopped retrying (plan §9 item 25). */
export default function AdminPublishMonitorPage() {
  return (
    <div className="space-y-6">
      <PublishMonitorQuota />
      <PublishMonitorReviewSettings />
      <PublishMonitorStuckCleanup />
    </div>
  );
}
