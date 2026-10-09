/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import {
  EMPTY_MONTHLY_REFUND_FORM, validateMonthlyRefundForm, validateRefundFields,
  type MonthlyRefundForm, type MonthlyRefundRequest, type RefundFormScope, type RejectReason,
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
  const [rejectReason, setRejectReason] = useState<RejectReason | ''>('');

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

  // Bumped on every edit; a response that started under an older revision is dropped so it can
  // never show (and then approve) a quote or intent for identifiers no longer on screen.
  const revision = useRef(0);
  const current = (started: number) => started === revision.current;

  function updateForm(patch: Partial<MonthlyRefundForm>) {
    revision.current += 1;
    setForm(value => ({ ...value, ...patch }));
    // Any edit invalidates what is shown; approval must match the order and quote on screen.
    setQuoted(null);
    setQuoteError(null);
    setIntent(null);
    setExecuteResult(null);
    setActionError(null);
    setStatusError(null);
    // A reason picked for one request must never carry over to another.
    setRejectReason('');
  }

  function validated() {
    const result = validateMonthlyRefundForm(form);
    setErrors(result.ok ? {} : result.errors);
    return result.ok ? result.request : null;
  }

  function fieldsOk(scope: RefundFormScope) {
    const found = validateRefundFields(form, scope);
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  const requestQuote = () => once(async () => {
    const request = validated();
    if (!request) return;
    const started = revision.current;
    setQuoting(true);
    setQuoteError(null);
    setActionError(null);
    try {
      const quote = await utils.admin.quoteMonthlyRefund.fetch(request, { staleTime: 0, retry: false });
      if (current(started)) setQuoted({ request, quote });
    } catch (error) {
      if (!current(started)) return;
      setQuoted(null);
      setQuoteError(getSafeErrorMessage(error, FALLBACK));
    } finally {
      setQuoting(false);
    }
  });

  const loadStatus = () => once(async () => {
    if (!fieldsOk('status')) return;
    const orderId = form.orderId.trim();
    const started = revision.current;
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const data = await utils.admin.getMonthlyRefundStatus.fetch({ orderId }, { staleTime: 0, retry: false });
      if (!current(started)) return;
      setIntent(data as MonthlyRefundIntent);
      setExecuteResult(null);
    } catch (error) {
      if (!current(started)) return;
      setIntent(null);
      setStatusError(getSafeErrorMessage(error, '这个订单还没有月付退款记录，或读取失败'));
    } finally {
      setLoadingStatus(false);
    }
  });

  const approveQuote = () => once(async () => {
    if (!quoted) return;
    const started = revision.current;
    setActionError(null);
    try {
      const data = await approve.mutateAsync({ ...quoted.request,
        versionHash: quoted.quote.versionHash, localVersion: quoted.quote.localVersion });
      if (!current(started)) return;
      setIntent(data as MonthlyRefundIntent);
      setExecuteResult(null);
    } catch (error) {
      if (current(started)) setActionError(getSafeErrorMessage(error, FALLBACK));
    }
  });

  const executeIntent = () => once(async () => {
    const terms = intent?.terms as { orderId?: unknown } | undefined;
    const orderId = typeof terms?.orderId === 'string' ? terms.orderId : form.orderId.trim();
    if (!intent || typeof intent.id !== 'string') return;
    const started = revision.current;
    setActionError(null);
    try {
      const data = await execute.mutateAsync({ orderId, intentId: intent.id }) as MonthlyRefundIntent;
      if (!current(started)) return;
      setExecuteResult(data);
      // A finished pass returns the stored intent; a stopped pass returns only a reason, while the
      // stored intent may have moved on (claimed, stages started), so re-read it before any next step.
      if (data && 'terms' in data) {
        setIntent(data);
        return;
      }
      try {
        const fresh = await utils.admin.getMonthlyRefundStatus.fetch({ orderId }, { staleTime: 0, retry: false });
        if (current(started) && fresh) setIntent(fresh as MonthlyRefundIntent);
      } catch {
        if (!current(started)) return;
        setIntent(null);
        setStatusError('执行已停止，但没能重新读取进度，请点"查看进度"');
      }
    } catch (error) {
      if (!current(started)) return;
      // The request may have reached the server: drop the old intent so nothing can be executed
      // again until "查看进度" reads where the refund actually is.
      setIntent(null);
      setExecuteResult(null);
      setActionError(getSafeErrorMessage(error, FALLBACK));
    }
  });

  const rejectRequest = (reason: RejectReason) => once(async () => {
    if (!fieldsOk('reject')) return;
    const started = revision.current;
    setActionError(null);
    try {
      const data = await reject.mutateAsync({ orderId: form.orderId.trim(), ticketId: form.ticketId.trim(), reason });
      if (!current(started)) return;
      setIntent(data as MonthlyRefundIntent);
      setQuoted(null);
      setRejectReason('');
    } catch (error) {
      if (current(started)) setActionError(getSafeErrorMessage(error, FALLBACK));
    }
  });

  return {
    form, errors, updateForm, quoted, quoting, quoteError, intent, executeResult, actionError, statusError,
    loadingStatus, busy, approving: approve.isPending, executing: execute.isPending, rejecting: reject.isPending,
    rejectReason, setRejectReason, requestQuote, loadStatus, approveQuote, executeIntent, rejectRequest,
  };
}
