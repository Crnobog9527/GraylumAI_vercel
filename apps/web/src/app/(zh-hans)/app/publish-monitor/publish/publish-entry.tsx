'use client';

import Link from 'next/link';
import { trpc } from '@/trpc/client';

/**
 * The library's entry to one-click publishing. Shown only when the topic has a final draft and the server says the plan
 * allows publishing and at least one platform is open; every other case (free plan, feature off, no open platform) shows
 * nothing, so users never meet a path that cannot work.
 */
export function PublishEntry({ workItemId, finalized }: { workItemId: string; finalized: boolean }) {
  const options = trpc.publishMonitor.publish.options.useQuery(undefined, { retry: false, enabled: finalized,
    refetchOnWindowFocus: false });
  if (!finalized || !options.data || options.data.platforms.length === 0) return null;
  return (
    <p>
      <Link href={`/app/publish-monitor/publish?item=${workItemId}`}>一键发布到已连接的海外账号</Link>
    </p>
  );
}
