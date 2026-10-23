'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/trpc/client';
import { canClearRequestId, voiceErrorCode, voiceErrorMessage, type VoiceProfile, type VoiceState } from '@/lib/voice/format';
import { MyVoiceView } from './my-voice-view';
import styles from './my-voice.module.css';

/** A generation request id survives a refresh, so retrying the same click never starts a second paid call. */
const REQUEST_KEY = 'voice-generate-request';
const POLL_MS = 5000;

export function MyVoice({ onOpenDocuments }: { onOpenDocuments: () => void }) {
  const [polling, setPolling] = useState(false);
  const query = trpc.voice.state.useQuery(undefined, { refetchOnMount: 'always', refetchInterval: polling ? POLL_MS : false });
  const state = query.data as VoiceState | undefined;
  const generate = trpc.voice.generate.useMutation();
  const confirm = trpc.voice.confirm.useMutation();
  const setEnabled = trpc.voice.setEnabled.useMutation();
  const remove = trpc.voice.delete.useMutation();
  const [preferred, setPreferred] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPolling(state?.latest?.status === 'generating'); }, [state?.latest?.status]);
  // Once a state read made after this page opened shows nothing generating, a kept request id has a final outcome: the next
  // click must start a new generation, never replay the old one. Never from cached state (a remount still holds the state
  // from before the paid call), or a click before the fresh read would start and charge a second generation (#1262 review).
  // A failed refetch also counts as "fetched after mount" and keeps the old data, so success is required too.
  const fresh = query.isFetchedAfterMount && query.isSuccess && !query.isFetching;
  useEffect(() => {
    if (canClearRequestId(fresh, state, generate.isPending)) sessionStorage.removeItem(REQUEST_KEY);
  }, [fresh, state, generate.isPending]);
  useEffect(() => {
    if (state && preferred === null) setPreferred(state.documents.filter(doc => doc.preferred).map(doc => doc.id));
  }, [state, preferred]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); }
    catch (error) {
      toast.error(voiceErrorMessage(error));
      if (voiceErrorCode(error) === 'VOICE_REVISION_CONFLICT') await query.refetch();
    } finally { setBusy(false); }
  }
  async function onGenerate() {
    let requestId = sessionStorage.getItem(REQUEST_KEY);
    if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(REQUEST_KEY, requestId); }
    const id = requestId;
    setPolling(true);
    await run(async () => {
      try { await generate.mutateAsync({ requestId: id, preferred: preferred ?? [] }); sessionStorage.removeItem(REQUEST_KEY); }
      catch (error) {
        // A refusal before anything started is final for this request id; an unknown outcome keeps it for a retry.
        if (voiceErrorCode(error)) sessionStorage.removeItem(REQUEST_KEY);
        throw error;
      } finally { await query.refetch(); }
    });
  }

  if (query.isPending) return <div className={styles.root}><p className={styles.hint}>正在读取…</p></div>;
  if (!state) return <div className={styles.root}><p className={styles.warn}>{voiceErrorMessage(query.error)}</p>
    <button type="button" onClick={() => void query.refetch()}>重试</button></div>;
  return <MyVoiceView state={state} preferred={preferred ?? []} busy={busy} generating={generate.isPending}
    onTogglePreferred={id => setPreferred(current => (current ?? []).includes(id)
      ? (current ?? []).filter(value => value !== id) : [...(current ?? []), id])}
    onGenerate={() => void onGenerate()}
    onToggleEnabled={enabled => void run(async () => {
      await setEnabled.mutateAsync({ expectedRevision: state.revision, enabled }); await query.refetch(); })}
    onConfirm={(versionId: string, profile: VoiceProfile) => void run(async () => {
      await confirm.mutateAsync({ versionId, expectedRevision: state.revision, profile }); await query.refetch();
      toast.success(state.enabled ? '文风画像已确认，之后写稿会按它来。' : '文风画像已保存。"写稿时使用我的文风"现在是关闭的，打开后才会用。'); })}
    onDelete={versionId => void run(async () => { await remove.mutateAsync({ versionId }); await query.refetch(); })}
    onOpenDocuments={onOpenDocuments} />;
}
