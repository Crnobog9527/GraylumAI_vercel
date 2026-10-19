// 后台兜底用的工单编号，规则与 packages/api/src/lib/ticketNumber.ts 一致：
// TK-<工单创建日期（UTC）>-<工单 ID 前 6 位大写>。正常情况下后台直接用接口返回的 ticket_number。
export function formatTicketNumber(id: string, createdAt: string | Date): string {
  const d = new Date(createdAt);
  const dateStr = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `TK-${dateStr}-${id.substring(0, 6).toUpperCase()}`;
}
