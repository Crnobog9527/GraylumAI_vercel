'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/trpc/client';

export const TICKET_PAGE_SIZE = 100;

type Filters = { status?: 'open' | 'in_progress' | 'closed'; category?: 'bug' | 'feature' | 'question' | 'account' | 'billing' | 'consult' | 'other' };

// 搜索时把第一页之后的工单也取回来（接口每页最多 100 条），这样老工单也能按编号搜到。
export function useTicketSearchPool<T>(enabled: boolean, filters: Filters, firstPageCount: number, total: number) {
  const utils = trpc.useUtils();
  const [extra, setExtra] = useState<{ key: string; tickets: T[] }>({ key: '', tickets: [] });
  const key = JSON.stringify(filters);

  useEffect(() => {
    if (!enabled || total <= firstPageCount) return;
    let cancelled = false;
    (async () => {
      const rest: T[] = [];
      for (let offset = TICKET_PAGE_SIZE; offset < total; offset += TICKET_PAGE_SIZE) {
        const page = await utils.admin.getAllTickets.fetch({ ...filters, limit: TICKET_PAGE_SIZE, offset });
        if (cancelled) return;
        rest.push(...((page.tickets ?? []) as T[]));
      }
      setExtra({ key, tickets: rest });
    })().catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, total, firstPageCount]);

  return extra.key === key ? extra.tickets : [];
}
