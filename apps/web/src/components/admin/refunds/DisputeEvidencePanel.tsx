/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';

type Evidence = {
  dispute: { providerDisputeId: string; provider: string; amount: number | null; currency: string | null; reason: string;
    status: string; openedAt: string; evidenceDueBy: string | null };
  order: { id: string; itemType: string; membershipLevel: string | null; billingCycle: string | null; amountTotal: number | null;
    currency: string | null; paymentMethod: string | null; paidAt: string | null; deliveredAt: string | null;
    entitlementStart: string | null; entitlementEnd: string | null; credits: number | null; termsVersion: string | null;
    termsAcceptedAt: string | null; autoRenew: boolean | null };
  customer: { email: string | null; accountCreatedAt: string | null };
  usage: { spendCount: number; creditsSpent: number; firstUseAt: string | null; lastUseAt: string | null };
};
const time = (v: string | null) => v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'n/a';
const money = (amount: number | null, currency: string | null) =>
  amount === null || !currency ? 'n/a' : `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
const product = (o: Evidence['order']) => o.itemType === 'membership_plan'
  ? `Graylum AI ${o.membershipLevel ?? ''} membership (${o.billingCycle ?? 'n/a'}${o.autoRenew ? ', auto-renewing' : ''})`
  : `Graylum AI credit pack (${o.credits ?? 'n/a'} credits)`;

/** CHARGEBACK G3: plain English text for Stripe's dispute evidence form, ready to copy. */
export function evidenceText(e: Evidence) {
  return [
    `Dispute ${e.dispute.providerDisputeId} (${e.dispute.provider}), reason: ${e.dispute.reason}, amount: ${money(e.dispute.amount, e.dispute.currency)}`,
    `Evidence due: ${time(e.dispute.evidenceDueBy)}`,
    '',
    `Customer email: ${e.customer.email ?? 'n/a'}`,
    `Account created: ${time(e.customer.accountCreatedAt)}`,
    '',
    `Product: ${product(e.order)}`,
    `Order: ${e.order.id}, charged ${money(e.order.amountTotal, e.order.currency)} via ${e.order.paymentMethod ?? 'n/a'}`,
    `Paid: ${time(e.order.paidAt)}; delivered (credits and access granted): ${time(e.order.deliveredAt)}`,
    `Service period: ${time(e.order.entitlementStart)} to ${time(e.order.entitlementEnd)}`,
    `Terms of Service and Refund Policy accepted at checkout: version ${e.order.termsVersion ?? 'n/a'} at ${time(e.order.termsAcceptedAt)}`
      + ' (the box is unchecked by default and payment is impossible without checking it)',
    '',
    `Usage after payment: ${e.usage.spendCount} paid AI actions, ${e.usage.creditsSpent} credits used,`
      + ` first ${time(e.usage.firstUseAt)}, last ${time(e.usage.lastUseAt)}`,
  ].join('\n');
}

export function DisputeEvidencePanel({ disputeId, onClose }: { disputeId: string; onClose: () => void }) {
  const evidence = trpc.paymentDisputes.evidence.useQuery({ disputeId });
  const [copied, setCopied] = useState('');
  const content = evidence.data ? evidenceText(evidence.data) : '';
  return <div className="space-y-2 rounded-lg border p-3" data-testid="dispute-evidence">
    <p className="font-bold">申诉材料汇总</p>
    <p className="text-sm">复制下面的英文材料，粘贴到 Stripe 后台这笔拒付的举证表单里提交（系统不会自动提交）。不含 IP 和设备信息。</p>
    {evidence.isLoading ? <p>正在读取…</p> : null}
    {evidence.isError ? <p role="alert">申诉材料暂时无法读取，请确认这笔拒付已对应到订单。</p> : null}
    {content ? <pre className="whitespace-pre-wrap break-all rounded border p-2 text-xs">{content}</pre> : null}
    {copied ? <p role="status">{copied}</p> : null}
    <Button disabled={!content} onClick={() => {
      void navigator.clipboard.writeText(content).then(() => setCopied('已复制。'), () => setCopied('复制失败，请手动选中文字复制。'));
    }}>复制材料</Button>
    <Button variant="outline" disabled={!content} onClick={() => window.print()}>打印</Button>
    <Button variant="outline" onClick={onClose}>收起</Button>
  </div>;
}
