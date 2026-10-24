/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import {
  EMPTY_MONTHLY_REFUND_FORM, ticketIdFor, validateRefundFields, type MonthlyRefundForm, type RefundFormScope, type RejectReason,
} from './monthlyRefundView';

const FALLBACK = '退款证据不足或状态已变化，请重新核对订单与工单';
/** Server quote (pay_common_package_refund_quote, 0252): minor units; netMinor = basis - fee + tax. */
export type PackageRefundQuote = { versionHash: string; currency: string; basisMinor: number; feeMinor: number;
  taxMinor?: number; netMinor: number; credits: number; treatment?: 'credit_package' | 'wallet_membership';
  cash?: { mode?: 'test' | 'live' } };
export type PackageRefundIntent = Record<string, unknown> & { id?: unknown; status?: unknown };

/**
 * Admin flow for one credit-pack order (PAY-COMMON PR-4B, MASTER_PLAN item 51): quote → approve pinned to that quote's
 * version → execute; or reject. Eligibility, fee, tax and the refund amount are all decided on the server.
 */
export function usePackageRefund() {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<MonthlyRefundForm>(EMPTY_MONTHLY_REFUND_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof MonthlyRefundForm, string>>>({});
  const [quote, setQuote] = useState<PackageRefundQuote | null>(null);
  const [intent, setIntent] = useState<PackageRefundIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rejectReason, setRejectReason] = useState<RejectReason | ''>('');
  const decide = trpc.admin.decidePackageRefund.useMutation();
  const execute = trpc.admin.executePackageRefund.useMutation();
  const reconcile = trpc.admin.reconcilePackageRefund.useMutation();
  const reject = trpc.admin.rejectPackageRefund.useMutation();
  const busy = loading || decide.isPending || execute.isPending || reconcile.isPending || reject.isPending;
  const inFlight = useRef(false);
  const revision = useRef(0);

  function updateForm(patch: Partial<MonthlyRefundForm>) {
    revision.current += 1;
    setForm(value => ({ ...value, ...patch }));
    // Any edit invalidates what is shown: approval must match the order and quote on screen.
    setQuote(null); setIntent(null); setError(null); setRejectReason('');
  }
  // The ticket ID behind a typed ticket number (TK-…), looked up once per typed value before any call that sends it.
  const ticket = useRef<{ typed: string; id: string } | null>(null);
  async function run(scope: RefundFormScope, action: () => Promise<void>) {
    const found = validateRefundFields(form, scope);
    setErrors(found);
    if (Object.keys(found).length || inFlight.current) return;
    inFlight.current = true; setLoading(true); setError(null);
    const started = revision.current;
    if (scope !== 'status' && ticket.current?.typed !== form.ticketId.trim()) {
      try {
        const typed = form.ticketId.trim();
        ticket.current = { typed, id: await ticketIdFor(typed, ticketNumber =>
          utils.admin.resolveRefundTicket.fetch({ ticketNumber }, { staleTime: 0, retry: false })) };
      } catch (caught) {
        if (started === revision.current) setErrors({ ticketId: getSafeErrorMessage(caught, '找不到这个工单编号，请到工单管理页复制') });
        inFlight.current = false; setLoading(false);
        return;
      }
    }
    try { await action(); } catch (caught) {
      if (started === revision.current) setError(getSafeErrorMessage(caught, FALLBACK));
    } finally { inFlight.current = false; setLoading(false); }
  }
  const request = () => ({ orderId: form.orderId.trim(),
    ticketId: ticket.current?.typed === form.ticketId.trim() ? ticket.current.id : form.ticketId.trim(),
    feePermitted: form.feePermitted as 'confirmed' | 'not_permitted', feeEvidence: form.feeEvidence.trim() });

  return {
    form, errors, quote, intent, error, busy, rejectReason, setRejectReason, updateForm,
    requestQuote: () => run('quote', async () => {
      const started = revision.current;
      const result = await utils.admin.previewPackageRefund.fetch(request()) as PackageRefundQuote;
      if (started === revision.current) setQuote(result);
    }),
    approve: () => run('quote', async () => {
      if (!quote) return;
      setIntent(await decide.mutateAsync({ ...request(), versionHash: quote.versionHash, decision: 'approve' }) as PackageRefundIntent);
      setQuote(null);
    }),
    execute: () => run('status', async () => {
      if (typeof intent?.id !== 'string') return;
      setIntent(await execute.mutateAsync({ orderId: request().orderId, intentId: intent.id }) as PackageRefundIntent);
    }),
    reconcile: () => run('status', async () => {
      setIntent(await reconcile.mutateAsync({ orderId: request().orderId }) as PackageRefundIntent);
    }),
    loadStatus: () => run('status', async () => {
      const result = await utils.admin.getPackageRefundStatus.fetch({ orderId: request().orderId });
      setIntent((result ?? null) as PackageRefundIntent | null);
      if (!result) setError('这个订单还没有退款记录');
    }),
    reject: () => run('reject', async () => {
      if (!rejectReason) return;
      setIntent(await reject.mutateAsync({ orderId: request().orderId, ticketId: request().ticketId, reason: rejectReason }) as PackageRefundIntent);
    }),
  };
}
