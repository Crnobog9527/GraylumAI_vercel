/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { EXPERT_CONSULT_COPY as COPY } from './expertConsultCopy';

export function ExpertConsultComingSoon() {
  return (
    <main className="mx-auto max-w-xl px-4 py-10" data-testid="expert-consult-coming-soon">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.comingSoonTitle}</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{COPY.comingSoonText}</p>
      <Link href="/app" className="mt-4 inline-block text-sm underline">{COPY.backToApp}</Link>
    </main>
  );
}
