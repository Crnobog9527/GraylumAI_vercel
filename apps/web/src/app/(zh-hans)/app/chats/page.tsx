'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';

/**
 * A phone's 对话 page (Owner 2026-11-12, phone plan A): the list a computer keeps down its left side (platforms, accounts
 * and their work, conversations, drafts not yet filed) as a page of its own, reached from the bottom bar. The list, its
 * menus and its dialogs are WorkspaceFrame's, unchanged; the `history` area only tells the frame to show the list as the
 * page on a phone. A computer has the list beside every page already, so it is sent on to the new-conversation page.
 */
export default function ChatsPage() {
  const router = useRouter();
  useEffect(() => {
    if (!window.matchMedia('(max-width: 639px)').matches) router.replace('/app/positioning');
  }, [router]);
  return <WorkspaceFrame area="history">{null}</WorkspaceFrame>;
}
