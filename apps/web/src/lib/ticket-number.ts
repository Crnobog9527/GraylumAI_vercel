// 后台显示的工单编号，规则与 packages/api/src/routers/ticket.ts 的 generateTicketNumber 一致：
// TK-<当天日期>-<工单 ID 前 6 位大写>。其中日期是用户查看当天的日期（服务器按 UTC，这里也按 UTC，保证与用户侧一致），只有后 6 位是稳定的。
export function formatTicketNumber(id: string, now: Date = new Date()): string {
  const dateStr = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `TK-${dateStr}-${id.substring(0, 6).toUpperCase()}`;
}

// 支持完整 TK 编号、编号后 6 位、完整 UUID 或其中一段；日期段不参与匹配，避免隔天对不上。
export function ticketMatchesQuery(id: string, query: string): boolean {
  const q = query.trim().toUpperCase().replace(/^#/, '');
  if (!q) return true;
  const short = id.substring(0, 6).toUpperCase();
  const tk = q.match(/^TK-\d{8}-([0-9A-Z]+)$/);
  const needle = tk ? tk[1] : q;
  return id.toUpperCase().startsWith(needle) || short.startsWith(needle) || id.toUpperCase().includes(needle);
}
