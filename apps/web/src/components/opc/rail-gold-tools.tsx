'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { trpc } from '@/trpc/client';
import { READ_RETRY } from '@/trpc/read-retry';
import { askCompare, COMPARE_ENTRY_HREF } from '@/components/fusion-compare/compare-entry';

// The rail is on every signed-in page; the paywall (with its checkout) and the chooser are fetched when an entry is pressed.
const ReportPaywallDialog = lazy(() => import('@/components/paywall/ReportPaywallDialog').then(module => ({ default: module.ReportPaywallDialog })));
const JuryChooser = lazy(() => import('@/components/fusion-review/JuryChooser').then(module => ({ default: module.JuryChooser })));

type CompareOptions = { enabled: true } | { enabled: false; reason?: string };
export type GoldToolEntry = 'hidden' | 'tool' | 'paywall';

/**
 * What each entry is, from the server's answers. `compare`: the compare options read (absent while unknown). `juryOn`: the
 * site-wide jury switch. `juryPlan`: whether the member's plan has the jury (null while unknown).
 */
export function goldToolEntries(
  compare: CompareOptions | undefined, juryOn: boolean, juryPlan: boolean | null,
): { compare: GoldToolEntry; jury: GoldToolEntry } {
  return {
    compare: !compare || (compare.enabled === false && compare.reason === 'disabled') ? 'hidden' : compare.enabled ? 'tool' : 'paywall',
    jury: !juryOn || juryPlan === null ? 'hidden' : juryPlan ? 'tool' : 'paywall',
  };
}

/**
 * What the rail's "多模型对比" and "评审团" entries do (Owner 2026-11-12: both belong in the rail, and a member whose plan
 * lacks one may still press it and is shown what it is, why to upgrade and which plan has it).
 *
 * An entry is absent while its tool is switched off for the whole site, and while that cannot be told (the read is still out
 * or failed): it never shows and then vanishes. Pressed by a member whose plan has the tool, the comparison runs on the page
 * with the message box (or the new-conversation page is opened), and the jury asks which report. Pressed by anyone else, the
 * tool's own paywall opens on this page. Which plan a tool needs is the server's answer, never written here.
 */
export function useRailGoldTools({ navigate, beforeOpen }: { navigate: (href: string) => void; beforeOpen?: () => void }): {
  onCompare?: () => void; onJury?: () => void; dialogs: ReactNode;
} {
  // The same reads, with the same options, as the pages that use the tools (ComparePicker.tsx, JuryEntry.tsx): one answer for both.
  const compare = trpc.fusionCompare.options.useQuery(undefined, { staleTime: 60_000, ...READ_RETRY }).data as CompareOptions | undefined;
  const jury = trpc.fusionReview.available.useQuery(undefined, { staleTime: 60_000, ...READ_RETRY }).data?.enabled === true;
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { enabled: jury, staleTime: 60_000, ...READ_RETRY });
  const [dialog, setDialog] = useState<'compare' | 'jury' | 'jury-choose' | null>(null);
  // The plan's answer for the jury: until it is known the entry waits, so nobody is shown a paywall or a tool by guess.
  const entry = goldToolEntries(compare, jury, entitlements.data ? entitlements.data.allowFusionReview === true : null);
  return {
    onCompare: entry.compare === 'hidden' ? undefined : () => {
      beforeOpen?.();
      if (entry.compare === 'paywall') { setDialog('compare'); return; }
      if (!askCompare()) navigate(COMPARE_ENTRY_HREF);
    },
    onJury: entry.jury === 'hidden' ? undefined : () => { beforeOpen?.(); setDialog(entry.jury === 'tool' ? 'jury-choose' : 'jury'); },
    dialogs: dialog && <Suspense fallback={null}>
      {dialog === 'compare' && <ReportPaywallDialog scene="compare" onClose={() => setDialog(null)} />}
      {dialog === 'jury' && <ReportPaywallDialog scene="jury" onClose={() => setDialog(null)} />}
      {dialog === 'jury-choose' && <JuryChooser onClose={() => setDialog(null)} />}
    </Suspense>,
  };
}
