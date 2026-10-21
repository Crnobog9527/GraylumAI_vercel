/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { currentMethodMembership, describeMethodMembership, type MethodMembershipRow } from './methodPlanAction';

/** Display the highest current paid membership; prior paid terms and credit grants remain unchanged.
 * Paid memberships from `payments.methodMembership`: level, how it was paid, and when it renews or ends. */
export function MethodMembershipSummary({ rows }: { rows: readonly MethodMembershipRow[] }) {
  const current = currentMethodMembership(rows);
  if (!current) return null;
  const view = describeMethodMembership(current);
  return (
    <ul data-testid="profile-method-memberships" className="mb-6 grid gap-2">
      <li key={`${current.subscription_id}:${current.entitlement_end}`} className="grid gap-0.5 rounded-xl border px-4 py-3 text-sm"
        style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-primary)' }}>
        <span className="flex flex-wrap items-baseline gap-x-2">
          <b style={{ color: 'var(--text-primary)' }}>{view.title}</b>
          <span style={{ color: 'var(--text-tertiary)' }}>{view.method}</span>
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>{view.status}</span>
      </li>
    </ul>
  );
}
