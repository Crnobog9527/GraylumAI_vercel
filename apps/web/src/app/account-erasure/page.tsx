/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { ErasureProgressPage } from '@/components/account-erasure/ErasureProgressPage';

export const metadata: Metadata = {
  title: '注销进度 · Graylum', robots: { index: false, follow: false }, referrer: 'no-referrer',
};
export default function Page() { return <ErasureProgressPage />; }
