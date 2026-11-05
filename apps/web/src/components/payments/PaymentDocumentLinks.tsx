/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ExternalLink, FileText, Receipt, ScrollText } from 'lucide-react';
import { getDocumentStatusPresentation, type AmountFactRow } from '@/lib/payment-display';

const TONE_COLORS = {
  success: { background: 'rgba(34,197,94,0.12)', color: '#4ade80' },
  muted: { background: 'rgba(148,163,184,0.12)', color: 'var(--text-tertiary)' },
  warning: { background: 'rgba(245,158,11,0.12)', color: '#f59e0b' },
} as const;

/** The same tones on the light profile center (the admin page keeps the dark ones above). */
const LIGHT_TONE_COLORS = {
  success: { background: 'var(--success-bg)', color: 'var(--success)' },
  muted: { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' },
  warning: { background: 'var(--warning-bg)', color: 'var(--warning)' },
} as const;
const LIGHT_LINK_COLORS = {
  invoicePdfUrl: { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' },
  hostedInvoiceUrl: { background: 'var(--info-bg)', color: 'var(--info)' },
  receiptUrl: { background: 'var(--success-bg)', color: 'var(--success)' },
} as const;

/** Unknown and unavailable use different words and colours so "could not check" never reads as "none". */
export function DocumentStatusBadge({ status, light = false }: { status: string | null | undefined; light?: boolean }) {
  const presentation = getDocumentStatusPresentation(status);
  return (
    <span
      data-testid="payment-document-status"
      data-status={status === 'available' || status === 'unavailable' ? status : 'unknown'}
      title={presentation.hint}
      className="rounded-full px-2.5 py-1 text-xs font-medium"
      style={(light ? LIGHT_TONE_COLORS : TONE_COLORS)[presentation.tone]}
    >
      {presentation.label}
    </span>
  );
}

type Links = { invoicePdfUrl: string | null; hostedInvoiceUrl: string | null; receiptUrl: string | null };

const LINKS = [
  { key: 'invoicePdfUrl', label: 'PDF 发票', Icon: FileText, colors: { background: 'rgba(255,215,0,0.12)', color: '#facc15' } },
  { key: 'hostedInvoiceUrl', label: '在线发票', Icon: ScrollText, colors: { background: 'rgba(59,130,246,0.12)', color: '#60a5fa' } },
  { key: 'receiptUrl', label: '收据', Icon: Receipt, colors: { background: 'rgba(34,197,94,0.12)', color: '#4ade80' } },
] as const;

/** Opens the payment channel's original documents; Graylum does not issue its own receipt. */
export function PaymentDocumentLinks({ record, light = false }: { record: Links; light?: boolean }) {
  return (
    <>
      {LINKS.map(({ key, label, Icon, colors }) => record[key] ? (
        <a
          key={key}
          href={record[key] ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
          style={light ? LIGHT_LINK_COLORS[key] : colors}
        >
          <Icon className="h-4 w-4" />
          {label}
          <ExternalLink className="h-4 w-4" />
        </a>
      ) : null)}
    </>
  );
}

export function AmountFactList({ rows, testId }: { rows: AmountFactRow[]; testId?: string }) {
  if (rows.length === 0) return null;
  return (
    <dl data-testid={testId} className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
      {rows.map(row => (
        <div key={row.label} className="flex gap-1">
          <dt>{row.label}</dt>
          <dd style={{ color: 'var(--text-secondary)' }}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
