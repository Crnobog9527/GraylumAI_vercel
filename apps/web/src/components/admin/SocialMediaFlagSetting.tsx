/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { socialMediaFlagErrorText, socialMediaFlagSavedText } from './socialMediaFlagView';

const muted = { color: 'var(--text-tertiary)' };
type VersionHook = (updatedAt: string) => void;

/**
 * POSITIONING-GATE: "与社交媒体相关", saved on its own (not with the module form). Every save sends the
 * flag and the module version this editor opened, so it never overwrites, or hides, a change made elsewhere.
 */
export function SocialMediaFlagSetting({ moduleId, moduleUpdatedAt, onVersion }: {
  moduleId: string | undefined; moduleUpdatedAt: string | undefined; onVersion: VersionHook;
}) {
  if (!moduleId || !moduleUpdatedAt) return null;
  return <SocialMediaFlagPanel moduleId={moduleId} moduleUpdatedAt={moduleUpdatedAt} onVersion={onVersion} />;
}

function SocialMediaFlagPanel({ moduleId, moduleUpdatedAt, onVersion }: {
  moduleId: string; moduleUpdatedAt: string; onVersion: VersionHook;
}) {
  const utils = trpc.useUtils();
  const current = trpc.socialMediaFlag.get.useQuery({ moduleId }, { staleTime: 0, retry: false });
  const update = trpc.socialMediaFlag.update.useMutation();
  const [selected, setSelected] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const inFlight = useRef(false);

  const saved = current.data?.socialMediaRelated;
  const value = selected ?? saved ?? false;
  useEffect(() => { setSelected(null); }, [saved]);
  const dirty = saved !== undefined && value !== saved;

  async function save() {
    if (saved === undefined || !dirty || inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    try {
      const next = await update.mutateAsync({ moduleId, socialMediaRelated: value, expectedSocialMediaRelated: saved,
        expectedModuleUpdatedAt: moduleUpdatedAt });
      utils.socialMediaFlag.get.setData({ moduleId }, next);
      setSelected(null);
      // Only this save moved the version (it was conditioned on the editor's), so the form above may adopt it.
      onVersion(next.moduleUpdatedAt);
      setNotice({ tone: 'ok', text: socialMediaFlagSavedText(next.socialMediaRelated) });
    } catch (error) {
      setNotice({ tone: 'error', text: socialMediaFlagErrorText(error) });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <section data-testid="social-media-flag-setting" className="space-y-3 rounded-lg border border-[var(--border-primary)] p-4">
      <Label style={{ color: 'var(--text-secondary)' }}>与社交媒体相关</Label>
      {current.isLoading ? <p className="text-sm" style={muted}>正在读取设置…</p>
        : current.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--error)' }}>
            {socialMediaFlagErrorText(current.error)}
            <Button type="button" variant="outline" size="sm" onClick={() => void current.refetch()}>重新读取</Button>
          </div>
        ) : current.data ? (
          <>
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" aria-label="与社交媒体相关" data-testid="social-media-flag-checkbox" checked={value}
                disabled={update.isPending} onChange={e => { setNotice(null); setSelected(e.target.checked); }} />
              这个 Skill 要用到用户自己的社媒账号定位
            </label>
            <p className="text-xs" style={muted}>勾选后，还没有确认定位的用户不能使用这个 Skill，会先被引导去做定位或导入已有定位。
              不要给“账号定位”这个 Skill 本身勾选。这里单独保存，不随上方“保存”提交。</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" data-testid="social-media-flag-save" disabled={!dirty || update.isPending} onClick={() => void save()}>
                {update.isPending ? '正在保存…' : '保存这个设置'}
              </Button>
            </div>
            {notice ? <p role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="social-media-flag-notice" className="text-sm"
              style={{ color: notice.tone === 'error' ? 'var(--error)' : 'var(--success)' }}>{notice.text}</p> : null}
          </>
        ) : null}
    </section>
  );
}
