/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { PublishMonitorReviewSettings } from '@/components/admin/PublishMonitorReviewSettings';

/** PUBLISH-MONITOR admin: weekly review settings. */
export default function AdminPublishMonitorPage() {
  return (
    <div className="space-y-6">
      <PublishMonitorReviewSettings />
    </div>
  );
}
