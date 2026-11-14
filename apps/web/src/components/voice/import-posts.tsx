'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/trpc/client';
import { voiceErrorMessage, type ImportCandidate, type ImportSource } from '@/lib/voice/format';
import { ImportPostsView } from './import-posts-view';

/** VOICE-2 PR-6: the import panel's data. Imports add 「我本人写的」 documents; `onImported` refreshes the voice page's list. */
export function ImportPosts({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const sources = trpc.voice.importSources.useQuery(undefined, { refetchOnMount: 'always' });
  const candidates = trpc.voice.importCandidates.useQuery({ connectionId: open ?? '' }, { enabled: Boolean(open) });
  const importPosts = trpc.voice.importPosts.useMutation();
  async function onImport() {
    if (!open || !picked.length) return;
    try {
      const result = await importPosts.mutateAsync({ connectionId: open, postIds: picked });
      toast.success(`已导入 ${result.imported} 篇${result.skipped ? `，跳过 ${result.skipped} 篇` : ''}。重新学习文风后会用上它们。`);
      setPicked([]);
      await Promise.all([candidates.refetch(), sources.refetch()]);
      onImported();
    } catch (error) { toast.error(voiceErrorMessage(error)); }
  }
  return <ImportPostsView sources={(sources.data as ImportSource[] | undefined) ?? (sources.isError ? [] : null)} busy={importPosts.isPending}
    open={open} candidates={open ? ((candidates.data?.posts as ImportCandidate[] | undefined) ?? null) : null} picked={picked}
    onOpen={id => { setOpen(id); setPicked([]); }}
    onPick={id => setPicked(current => current.includes(id) ? current.filter(x => x !== id) : current.length >= 30 ? current : [...current, id])}
    onImport={() => void onImport()} />;
}
