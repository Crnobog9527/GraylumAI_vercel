/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { describeMethodMembership, type MethodMembershipRow } from './methodPlanAction';

/** Paid memberships from `payments.methodMembership`: level, how it was paid, and when it renews or ends. */
export function MethodMembershipSummary({ rows }: { rows: readonly MethodMembershipRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul data-testid="profile-method-memberships" className="mb-6 grid gap-2">
      {rows.map(row => {
        const view = describeMethodMembership(row);
        return (
          <li key={`${row.subscription_id}:${row.entitlement_end}`} className="grid gap-0.5 rounded-xl border px-4 py-3 text-sm"
            style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-primary)' }}>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <b style={{ color: 'var(--text-primary)' }}>{view.title}</b>
              <span style={{ color: 'var(--text-tertiary)' }}>{view.method}</span>
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{view.status}</span>
          </li>
        );
      })}
    </ul>
  );
}
