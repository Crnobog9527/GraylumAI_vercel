// 工单编号：TK-<创建日期 UTC>-<工单 ID 前 6 位大写>。
// 用户侧和后台都用工单的 created_at 生成，同一张工单两边编号一致。
export function formatTicketNumber(id: string, createdAt: string | Date): string {
  const d = new Date(createdAt);
  const dateStr = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `TK-${dateStr}-${id.substring(0, 6).toUpperCase()}`;
}

export type TicketIdRange = { kind: 'eq'; id: string } | { kind: 'range'; min: string; max: string } | { kind: 'none' };

// 把后台搜索框的输入（完整 TK 编号、后 6 位、UUID 前缀、完整 UUID）变成 tickets.id 上的范围条件。
// 日期段不参与匹配。只做前缀匹配，不需要新的数据库迁移。
export function ticketIdRangeFromQuery(query: string): TicketIdRange | null {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (!q) return null;
  const tk = q.match(/^tk-\d{8}-([0-9a-z]+)$/);
  const needle = (tk ? tk[1] : q).replace(/-/g, '');
  if (!/^[0-9a-f]{1,32}$/.test(needle)) return { kind: 'none' };
  const pad = (c: string) => {
    const h = needle.padEnd(32, c);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  if (needle.length === 32) return { kind: 'eq', id: pad('0') };
  return { kind: 'range', min: pad('0'), max: pad('f') };
}

// 给 tickets 查询加上按编号搜索的条件；搜索词不可能匹配任何工单时用全零 UUID 过滤（不会是真实工单）。
export function applyTicketIdSearch<Q extends { eq: (c: string, v: string) => Q; gte: (c: string, v: string) => Q; lte: (c: string, v: string) => Q }>(
  query: Q,
  search: string | undefined,
): Q {
  const range = ticketIdRangeFromQuery(search ?? '');
  if (!range) return query;
  if (range.kind === 'none') return query.eq('id', '00000000-0000-0000-0000-000000000000');
  if (range.kind === 'eq') return query.eq('id', range.id);
  return query.gte('id', range.min).lte('id', range.max);
}
