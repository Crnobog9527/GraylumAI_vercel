'use client';

export function TicketSearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="search"
      data-testid="admin-ticket-search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="按工单编号搜索（TK-…）"
      className="h-9 w-[220px] rounded-md px-3 text-sm bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-[var(--text-primary)]"
    />
  );
}
