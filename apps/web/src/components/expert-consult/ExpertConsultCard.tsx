/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { EXPERT_CONSULT_COPY as COPY } from './expertConsultCopy';

/**
 * The booking entry shown at the end of a finalized report, on the pricing page and on the studio
 * contact page. It only links to the signed-in booking page, which checks eligibility on the server.
 */
export function ExpertConsultCard({ href, className }: { href: string; className?: string }) {
  return (
    <section data-testid="expert-consult-card"
      className={['grid gap-3 rounded-2xl border p-5 md:grid-cols-[1fr_auto] md:items-center', className].filter(Boolean).join(' ')}
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.cardTitle}</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{COPY.cardLede}</p>
      </div>
      <Link href={href} className="rounded-lg border px-4 py-2 text-center text-sm font-medium"
        style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>{COPY.cta}</Link>
    </section>
  );
}
