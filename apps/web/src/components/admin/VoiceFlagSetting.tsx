/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { voiceFlagErrorText, voiceFlagSavedText } from './voiceFlagView';

const muted = { color: 'var(--text-tertiary)' };
type VersionHook = (updatedAt: string) => void;

/**
 * VOICE: "使用用户文风", saved on its own like "与社交媒体相关" (VoiceFlagSetting). Every save sends the
 * flag and the module version this editor opened, so it never overwrites, or hides, a change made elsewhere.
 */
export function VoiceFlagSetting({ moduleId, moduleUpdatedAt, onVersion }: {
  moduleId: string | undefined; moduleUpdatedAt: string | undefined; onVersion: VersionHook;
}) {
  if (!moduleId || !moduleUpdatedAt) return null;
  return <VoiceFlagPanel moduleId={moduleId} moduleUpdatedAt={moduleUpdatedAt} onVersion={onVersion} />;
}

function VoiceFlagPanel({ moduleId, moduleUpdatedAt, onVersion }: {
  moduleId: string; moduleUpdatedAt: string; onVersion: VersionHook;
}) {
  const utils = trpc.useUtils();
  const current = trpc.voiceFlag.get.useQuery({ moduleId }, { staleTime: 0, retry: false });
  const update = trpc.voiceFlag.update.useMutation();
  const [selected, setSelected] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const inFlight = useRef(false);

  const saved = current.data?.usesUserVoice;
  const value = selected ?? saved ?? false;
  useEffect(() => { setSelected(null); }, [saved]);
  const dirty = saved !== undefined && value !== saved;

  async function save() {
    if (saved === undefined || !dirty || inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    try {
      const next = await update.mutateAsync({ moduleId, usesUserVoice: value, expectedUsesUserVoice: saved,
        expectedModuleUpdatedAt: moduleUpdatedAt });
      utils.voiceFlag.get.setData({ moduleId }, next);
      setSelected(null);
      // Only this save moved the version (it was conditioned on the editor's), so the form above may adopt it.
      onVersion(next.moduleUpdatedAt);
      setNotice({ tone: 'ok', text: voiceFlagSavedText(next.usesUserVoice) });
    } catch (error) {
      setNotice({ tone: 'error', text: voiceFlagErrorText(error) });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <section data-testid="voice-flag-setting" className="space-y-3 rounded-lg border border-[var(--border-primary)] p-4">
      <Label style={{ color: 'var(--text-secondary)' }}>使用用户文风</Label>
      {current.isLoading ? <p className="text-sm" style={muted}>正在读取设置…</p>
        : current.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--error)' }}>
            {voiceFlagErrorText(current.error)}
            <Button type="button" variant="outline" size="sm" onClick={() => void current.refetch()}>重新读取</Button>
          </div>
        ) : current.data ? (
          <>
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" aria-label="使用用户文风" data-testid="voice-flag-checkbox" checked={value}
                disabled={update.isPending} onChange={e => { setNotice(null); setSelected(e.target.checked); }} />
              这是写作类 Skill，按用户确认过的文风来写
            </label>
            <p className="text-xs" style={muted}>勾选后，用户确认过文风画像、并开着“使用我的文风”时，这个 Skill 写稿会带上他的文风画像；
              没有画像的用户不受影响。这里单独保存，不随上方“保存”提交。</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" data-testid="voice-flag-save" disabled={!dirty || update.isPending} onClick={() => void save()}>
                {update.isPending ? '正在保存…' : '保存这个设置'}
              </Button>
            </div>
            {notice ? <p role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="voice-flag-notice" className="text-sm"
              style={{ color: notice.tone === 'error' ? 'var(--error)' : 'var(--success)' }}>{notice.text}</p> : null}
          </>
        ) : null}
    </section>
  );
}
