/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { PublishMonitorStuckCleanup } from '@/components/admin/PublishMonitorStuckCleanup';

/** PUBLISH-MONITOR admin: Post for Me cleanup that stopped retrying (plan §9 item 25). */
export default function AdminPublishMonitorCleanupPage() {
  return <PublishMonitorStuckCleanup />;
}
