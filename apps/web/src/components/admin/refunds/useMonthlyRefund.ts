/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import {
  EMPTY_MONTHLY_REFUND_FORM, validateMonthlyRefundForm,
  type MonthlyRefundForm, type MonthlyRefundRequest, type RejectReason,
} from './monthlyRefundView';

const FALLBACK = '退款证据不足或状态已变化，请重新核对订单与工单';
type Quote = Awaited<ReturnType<ReturnType<typeof trpc.useUtils>['admin']['quoteMonthlyRefund']['fetch']>>;
// The status and execute procedures return the stored intent as untyped JSON.
export type MonthlyRefundIntent = Record<string, unknown> & { id?: unknown; status?: unknown };

/**
 * Admin flow for one order: quote (read-only, fetched only on click so it never refetches by
 * itself) → approve pinned to that quote's versions → execute separately; or reject.
 * Every money decision is re-checked on the server; this hook only sequences the calls.
 */
export function useMonthlyRefund() {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<MonthlyRefundForm>(EMPTY_MONTHLY_REFUND_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof MonthlyRefundForm, string>>>({});
  const [quoted, setQuoted] = useState<{ request: MonthlyRefundRequest; quote: Quote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [intent, setIntent] = useState<MonthlyRefundIntent | null>(null);
  const [executeResult, setExecuteResult] = useState<MonthlyRefundIntent | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const approve = trpc.admin.approveMonthlyRefund.useMutation();
  const execute = trpc.admin.executeMonthlyRefund.useMutation();
  const reject = trpc.admin.rejectMonthlyRefund.useMutation();
  const busy = quoting || loadingStatus || approve.isPending || execute.isPending || reject.isPending;
  // A double click lands before React re-renders the disabled button; this ref closes that gap.
  const inFlight = useRef(false);
  async function once(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    try { await action(); } finally { inFlight.current = false; }
  }

  function updateForm(patch: Partial<MonthlyRefundForm>) {
    setForm(value => ({ ...value, ...patch }));
    // Any edit invalidates what is shown; approval must match the order and quote on screen.
    setQuoted(null);
    setQuoteError(null);
    setIntent(null);
    setExecuteResult(null);
    setActionError(null);
    setStatusError(null);
  }

  function validated() {
    const result = validateMonthlyRefundForm(form);
    setErrors(result.ok ? {} : result.errors);
    return result.ok ? result.request : null;
  }

  const requestQuote = () => once(async () => {
    const request = validated();
    if (!request) return;
    setQuoting(true);
    setQuoteError(null);
    setActionError(null);
    try {
      const quote = await utils.admin.quoteMonthlyRefund.fetch(request, { staleTime: 0, retry: false });
      setQuoted({ request, quote });
    } catch (error) {
      setQuoted(null);
      setQuoteError(getSafeErrorMessage(error, FALLBACK));
    } finally {
      setQuoting(false);
    }
  });

  const loadStatus = () => once(async () => {
    const request = validated();
    if (!request) return;
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const data = await utils.admin.getMonthlyRefundStatus.fetch({ orderId: request.orderId }, { staleTime: 0, retry: false });
      setIntent(data as MonthlyRefundIntent);
    } catch (error) {
      setIntent(null);
      setStatusError(getSafeErrorMessage(error, '这个订单还没有月付退款记录，或读取失败'));
    } finally {
      setLoadingStatus(false);
    }
  });

  const approveQuote = () => once(async () => {
    if (!quoted) return;
    setActionError(null);
    try {
      const data = await approve.mutateAsync({ ...quoted.request,
        versionHash: quoted.quote.versionHash, localVersion: quoted.quote.localVersion });
      setIntent(data as MonthlyRefundIntent);
      setExecuteResult(null);
    } catch (error) {
      setActionError(getSafeErrorMessage(error, FALLBACK));
    }
  });

  const executeIntent = () => once(async () => {
    const terms = intent?.terms as { orderId?: unknown } | undefined;
    const orderId = typeof terms?.orderId === 'string' ? terms.orderId : form.orderId.trim();
    if (!intent || typeof intent.id !== 'string') return;
    setActionError(null);
    try {
      const data = await execute.mutateAsync({ orderId, intentId: intent.id }) as MonthlyRefundIntent;
      setExecuteResult(data);
      // A finished pass returns the stored intent; a stopped pass returns only a reason.
      if (data && 'terms' in data) setIntent(data);
    } catch (error) {
      setActionError(getSafeErrorMessage(error, FALLBACK));
    }
  });

  const rejectRequest = (reason: RejectReason) => once(async () => {
    const request = validated();
    if (!request) return;
    setActionError(null);
    try {
      const data = await reject.mutateAsync({ orderId: request.orderId, ticketId: request.ticketId, reason });
      setIntent(data as MonthlyRefundIntent);
      setQuoted(null);
    } catch (error) {
      setActionError(getSafeErrorMessage(error, FALLBACK));
    }
  });

  return {
    form, errors, updateForm, quoted, quoting, quoteError, intent, executeResult, actionError, statusError,
    loadingStatus, busy, approving: approve.isPending, executing: execute.isPending, rejecting: reject.isPending,
    requestQuote, loadStatus, approveQuote, executeIntent, rejectRequest,
  };
}
