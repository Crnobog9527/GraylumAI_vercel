/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ExpertConsultForm } from '@/components/expert-consult/ExpertConsultForm';
import { ExpertConsultComingSoon } from '@/components/expert-consult/ExpertConsultComingSoon';
import { EXPERT_CONSULT_ENTRY_OPEN, isExpertConsultSource } from '@/components/expert-consult/expertConsultCopy';

/** EXPERT-CONSULT booking page; signed-in only (proxy), noindex like every page without public metadata. */
function ExpertConsultPage() {
  const from = useSearchParams().get('from');
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <ExpertConsultForm source={isExpertConsultSource(from) ? from : 'pricing'} />
    </main>
  );
}

export default function Page() {
  if (!EXPERT_CONSULT_ENTRY_OPEN) return <ExpertConsultComingSoon />;
  return <Suspense><ExpertConsultPage /></Suspense>;
}
