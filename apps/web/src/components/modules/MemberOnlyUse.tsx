'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReportPaywallDialog } from '@/components/paywall/ReportPaywallDialog';
import { trpc } from '@/trpc/client';
import { MEMBER_ONLY_PREFILL, MEMBER_PAYWALL_EVENT, meetsMemberLevel, memberOnlyNote, prefillNewTask, requestMemberPaywall,
  type RequiredMemberLevel } from '@/lib/member-only';

/**
 * MEMBER-ONLY-MODULES (Owner 2026-11-04): the "use" button of a Skill limited to members. A plan at or above the requirement opens the
 * chat with the request typed in (the chat loads the Skill itself, and its own member gate stays there); a plan below it, or one not yet
 * known, meets the paywall (the `coach` scene sells Pro and Gold) and nothing is loaded.
 */
export function MemberOnlyUse({ level, onClose, onUsed }: { level: RequiredMemberLevel; onClose: () => void; onUsed?: () => void }) {
  const router = useRouter();
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { staleTime: 30_000, retry: false });
  // A plan still loading disables the button; one that could not be read lets a click through (the chat's own gate still holds), so a
  // paying member is never sold a plan after a transient error.
  const locked = entitlements.isSuccess && !meetsMemberLevel(entitlements.data?.level, level);
  const use = () => {
    if (locked) { onClose(); requestMemberPaywall(level); return; }
    onUsed?.();
    prefillNewTask(MEMBER_ONLY_PREFILL);
    router.push('/app/positioning');
    onClose();
  };
  return (
      <Button
        onClick={use}
        disabled={entitlements.isLoading}
        className="flex-1 h-11 rounded-xl font-semibold transition-all duration-300 hover:scale-[1.02]"
        style={{
          background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
          color: 'var(--bg-primary)',
          boxShadow: '0 4px 20px rgba(255, 215, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.2)',
        }}
      >
        <Sparkles className="h-4 w-4 mr-2" />
        立即使用
      </Button>
  );
}

/** Shows the paywall a member-only module's button asked for, outside the detail dialog (a portal on the page body). */
export function MemberOnlyPaywallHost() {
  const [level, setLevel] = useState<RequiredMemberLevel | null>(null);
  useEffect(() => {
    const open = (event: Event) => setLevel((event as CustomEvent<RequiredMemberLevel>).detail);
    window.addEventListener(MEMBER_PAYWALL_EVENT, open);
    return () => window.removeEventListener(MEMBER_PAYWALL_EVENT, open);
  }, []);
  return level ? createPortal(<ReportPaywallDialog scene="coach" minLevel={level} onClose={() => setLevel(null)} />, document.body) : null;
}

/** The workbench marketplace's detail action for a member-only Skill: the note, then "use" (the chat for a member, the paywall below the plan). */
export function MemberOnlyLinkAction({ level, className, noticeClassName }:
  { level: RequiredMemberLevel; className?: string; noticeClassName?: string }) {
  const [paywall, setPaywall] = useState(false);
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { staleTime: 30_000, retry: false });
  const locked = entitlements.isSuccess && !meetsMemberLevel(entitlements.data?.level, level);
  return (
    <>
      <p className={noticeClassName} data-testid="member-only-note">{memberOnlyNote(level)}{locked ? '，开通会员后即可使用' : ''}</p>
      {locked
        ? <button className={className} onClick={() => setPaywall(true)}>使用</button>
        : <Link className={className} href="/app/positioning"
          aria-disabled={entitlements.isLoading} onClick={() => prefillNewTask(MEMBER_ONLY_PREFILL)}>使用</Link>}
      {paywall && <ReportPaywallDialog scene="coach" minLevel={level} onClose={() => setPaywall(false)} />}
    </>
  );
}
