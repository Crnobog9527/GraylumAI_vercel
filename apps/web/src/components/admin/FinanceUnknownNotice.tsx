/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { AlertTriangle } from 'lucide-react';
import type { FinanceUnknownItem } from './financeStatus';

/** One quiet warning line per unrecognized category; renders nothing when everything is known. */
export function FinanceUnknownNotice({ items }: { items: FinanceUnknownItem[] }) {
  if (items.length === 0) return null;
  return (
    <div
      data-testid="admin-finance-unknown-notice"
      role="status"
      className="space-y-1 rounded-lg border px-3 py-2 text-xs"
      style={{ background: 'var(--warning-bg)', borderColor: 'var(--warning)', color: 'var(--text-secondary)' }}
    >
      {items.map((item) => (
        <p key={item.key} data-testid={`admin-finance-unknown-${item.key}`} className="flex flex-wrap items-center gap-x-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--warning)' }} />
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{item.title}</span>
          <span>{item.count} 条</span>
          {item.values.length > 0 && (
            <span className="break-all" style={{ color: 'var(--text-tertiary)' }}>
              {item.values.map(({ value, count }) => `${value} × ${count}`).join('、')}
            </span>
          )}
        </p>
      ))}
    </div>
  );
}
