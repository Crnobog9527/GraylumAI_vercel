/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { monthlyRefundCodeText, monthlyRefundQuoteRefusal, type QuoteRefusal } from './monthlyRefundReasons';
import {
  EMPTY_MONTHLY_REFUND_FORM, ticketIdFor, validateMonthlyRefundForm, validateRefundFields,
  type MonthlyRefundForm, type MonthlyRefundRequest, type RefundFormScope, type RejectReason,
} from './monthlyRefundView';

const FALLBACK = '退款证据不足或状态已变化，请重新核对订单与工单';
export const NO_RECORD = '这个订单还没有月付退款记录';
type Quote = Awaited<ReturnType<ReturnType<typeof trpc.useUtils>['admin']['quoteMonthlyRefund']['fetch']>>;
// The status and execute procedures return the stored intent as untyped JSON.
export type MonthlyRefundIntent = Record<string, unknown> & { id?: unknown; status?: unknown };

/**
 * Admin flow for one order: quote (read-only, fetched only on click so it never refetches by
 * itself) → approve pinned to that quote's versions → execute separately; or reject.
 * Every money decision is re-checked on the server; this hook only sequences the calls.
 */
export type RefundVariant = 'monthly' | 'subscription';
// Both families are the same server procedures (PAY-REFUND #1248); the subscription names are the
// yearly / founder / Pro-to-Gold entry.
const PROCEDURES = {
  monthly: { quote: 'quoteMonthlyRefund', approve: 'approveMonthlyRefund', execute: 'executeMonthlyRefund',
    reject: 'rejectMonthlyRefund', status: 'getMonthlyRefundStatus' },
  subscription: { quote: 'quoteSubscriptionRefund', approve: 'approveSubscriptionRefund', execute: 'executeSubscriptionRefund',
    reject: 'rejectSubscriptionRefund', status: 'getSubscriptionRefundStatus' },
} as const;

export function useMonthlyRefund(variant: RefundVariant = 'monthly') {
  const names = PROCEDURES[variant];
  const utils = trpc.useUtils();
  const [form, setForm] = useState<MonthlyRefundForm>(EMPTY_MONTHLY_REFUND_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof MonthlyRefundForm, string>>>({});
  const [quoted, setQuoted] = useState<{ request: MonthlyRefundRequest; quote: Quote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<QuoteRefusal | null>(null);
  const [intent, setIntent] = useState<MonthlyRefundIntent | null>(null);
  const [executeResult, setExecuteResult] = useState<MonthlyRefundIntent | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [rejectReason, setRejectReason] = useState<RejectReason | ''>('');

  const approve = trpc.admin[names.approve].useMutation();
  const execute = trpc.admin[names.execute].useMutation();
  const reject = trpc.admin[names.reject].useMutation();
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

  // A ticket number (TK-…) becomes its ticket ID before any refund call; a wrong number stays a field error.
  const lookupTicket = (ticketNumber: string) => utils.admin.resolveRefundTicket.fetch({ ticketNumber }, { staleTime: 0, retry: false });
  async function withTicketId<T extends { ticketId: string }>(request: T): Promise<T | null> {
    try { return { ...request, ticketId: await ticketIdFor(request.ticketId, lookupTicket) }; } catch (error) {
      setErrors({ ticketId: getSafeErrorMessage(error, '找不到这个工单编号，请到工单管理页复制') });
      return null;
    }
  }

  const requestQuote = () => once(async () => {
    const valid = validated();
    if (!valid) return;
    const started = revision.current;
    const request = await withTicketId(valid);
    if (!request || !current(started)) return;
    setQuoting(true);
    setQuoteError(null);
    setActionError(null);
    try {
      const quote = await utils.admin[names.quote].fetch(request, { staleTime: 0, retry: false });
      if (current(started)) setQuoted({ request, quote });
    } catch (error) {
      if (!current(started)) return;
      setQuoted(null);
      setQuoteError(monthlyRefundQuoteRefusal(error, FALLBACK));
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
      const data = await utils.admin[names.status].fetch({ orderId }, { staleTime: 0, retry: false });
      if (!current(started)) return;
      setExecuteResult(null);
      // Since #759 an existing order without any refund record answers null, not an error.
      if (data === null) {
        setIntent(null);
        setStatusError(variant === 'monthly' ? NO_RECORD : '这个订单还没有退款记录');
        return;
      }
      setIntent(data as MonthlyRefundIntent);
    } catch (error) {
      if (!current(started)) return;
      setIntent(null);
      setStatusError(monthlyRefundCodeText(error) ?? '暂时无法读取退款进度，请稍后再试');
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
        const fresh = await utils.admin[names.status].fetch({ orderId }, { staleTime: 0, retry: false });
        if (current(started) && fresh) setIntent(fresh as MonthlyRefundIntent);
      } catch {
        if (!current(started)) return;
        setIntent(null);
        setQuoted(null);
        setStatusError('执行已停止，但没能重新读取进度，请点"查看进度"');
      }
    } catch (error) {
      if (!current(started)) return;
      // The request may have reached the server: drop the old intent and quote so nothing can be
      // approved or executed again until "查看进度" reads where the refund actually is.
      setIntent(null);
      setQuoted(null);
      setExecuteResult(null);
      setActionError(getSafeErrorMessage(error, FALLBACK));
    }
  });

  const rejectRequest = (reason: RejectReason) => once(async () => {
    if (!fieldsOk('reject')) return;
    const started = revision.current;
    setActionError(null);
    const request = await withTicketId({ orderId: form.orderId.trim(), ticketId: form.ticketId.trim(), reason });
    if (!request || !current(started)) return;
    try {
      const data = await reject.mutateAsync(request);
      if (!current(started)) return;
      setIntent(data as MonthlyRefundIntent);
      setQuoted(null);
      setRejectReason('');
    } catch (error) {
      // A code without its own text gets the generic sentence, never the raw code.
      if (current(started)) setActionError(monthlyRefundCodeText(error) ?? FALLBACK);
    }
  });

  return {
    form, errors, updateForm, quoted, quoting, quoteError, intent, executeResult, actionError, statusError,
    loadingStatus, busy, approving: approve.isPending, executing: execute.isPending, rejecting: reject.isPending,
    rejectReason, setRejectReason, requestQuote, loadStatus, approveQuote, executeIntent, rejectRequest,
  };
}
