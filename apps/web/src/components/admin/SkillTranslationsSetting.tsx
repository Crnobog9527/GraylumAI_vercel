/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  draftFrom, invalidTranslation, skillTranslationsErrorText, translationRows, translationsFrom, type TranslationDraft,
} from './skillTranslationsView';

const muted = { color: 'var(--text-tertiary)' };
type VersionHook = (updatedAt: string) => void;

/**
 * SKILL-I18N-HOOK: English versions of the Skill text users see, saved on their own (not with the module form).
 * The Skill itself stays in Chinese; empty inputs fall back to the Chinese original. Every save sends the module
 * version this editor opened, so it never overwrites, or hides, a change made elsewhere.
 */
export function SkillTranslationsSetting({ moduleId, moduleUpdatedAt, onVersion }: {
  moduleId: string | undefined; moduleUpdatedAt: string | undefined; onVersion: VersionHook;
}) {
  if (!moduleId || !moduleUpdatedAt) return null;
  return <SkillTranslationsPanel moduleId={moduleId} moduleUpdatedAt={moduleUpdatedAt} onVersion={onVersion} />;
}

function SkillTranslationsPanel({ moduleId, moduleUpdatedAt, onVersion }: {
  moduleId: string; moduleUpdatedAt: string; onVersion: VersionHook;
}) {
  const utils = trpc.useUtils();
  const current = trpc.skillTranslations.get.useQuery({ moduleId }, { staleTime: 0, retry: false });
  const update = trpc.skillTranslations.update.useMutation();
  // Only the inputs this editor changed; every other input shows the latest saved translation.
  const [edits, setEdits] = useState<TranslationDraft>({});
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const inFlight = useRef(false);

  const source = current.data?.source ?? null;
  const saved = useMemo(() => (source ? draftFrom(source, current.data?.translations.en) : {}), [source, current.data]);
  const rows = useMemo(() => (source ? translationRows(source) : []), [source]);
  const draft = { ...saved, ...edits };
  const dirty = Object.entries(edits).some(([key, value]) => value.trim() !== (saved[key] ?? ''));

  async function save() {
    if (!source || !dirty || inFlight.current) return;
    const bad = invalidTranslation(rows, draft);
    if (bad) { setNotice({ tone: 'error', text: `「${bad.original}」的英文要写成一行，最多 160 个字符。` }); return; }
    inFlight.current = true;
    setNotice(null);
    try {
      // Another setting in this editor may have moved the module version after these translations were read; the
      // version alone would then let this draft overwrite translations another tab saved, so re-read them first.
      if (current.data?.moduleUpdatedAt !== moduleUpdatedAt) {
        const fresh = (await current.refetch()).data;
        if (!fresh || fresh.moduleUpdatedAt !== moduleUpdatedAt
          || JSON.stringify(fresh.translations) !== JSON.stringify(current.data?.translations)) {
          setNotice({ tone: 'error', text: skillTranslationsErrorText(new Error('SKILL_TRANSLATIONS_CONFLICT')) });
          return;
        }
      }
      const next = await update.mutateAsync({ moduleId, locale: 'en', translations: translationsFrom(source, draft),
        expectedModuleUpdatedAt: moduleUpdatedAt });
      utils.skillTranslations.get.setData({ moduleId }, next);
      setEdits({});
      // Only this save moved the version (it was conditioned on the editor's), so the form above may adopt it.
      onVersion(next.moduleUpdatedAt);
      setNotice({ tone: 'ok', text: '已保存英文对照。没填的地方，英文界面会显示中文原文。' });
    } catch (error) {
      setNotice({ tone: 'error', text: skillTranslationsErrorText(error) });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <section data-testid="skill-translations-setting" className="space-y-3 rounded-lg border border-[var(--border-primary)] p-4">
      <Label style={{ color: 'var(--text-secondary)' }}>英文对照（用户看到的文字）</Label>
      {current.isLoading ? <p className="text-sm" style={muted}>正在读取英文对照…</p>
        : current.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--error)' }}>
            {skillTranslationsErrorText(current.error)}
            <Button type="button" variant="outline" size="sm" onClick={() => void current.refetch()}>重新读取</Button>
          </div>
        ) : !source ? <p className="text-sm" style={muted}>这个 Skill 还没有发布，发布后才能填写英文对照。</p>
          : (
            <>
              <p className="text-xs" style={muted}>Skill 正文保持中文原版，这里只给步骤名、字段名和报告标题配英文，供以后的英文界面显示。
                AI 会按用户使用的语言回答，不需要在这里设置。没填的地方显示中文原文。这里单独保存，不随上方“保存”提交。</p>
              <div className="space-y-2">
                {rows.map(row => (
                  <div key={row.key} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <span className="mr-2 text-xs" style={muted}>{row.kind}</span>{row.original}
                    </span>
                    <Input aria-label={`${row.kind}「${row.original}」的英文`} data-testid={`skill-translation-${row.key}`}
                      value={draft[row.key] ?? ''} maxLength={200} disabled={update.isPending} placeholder="English"
                      onChange={e => { setNotice(null); const value = e.target.value; setEdits(old => ({ ...old, [row.key]: value })); }} />
                  </div>
                ))}
              </div>
              <Button type="button" data-testid="skill-translations-save" disabled={!dirty || update.isPending}
                onClick={() => void save()}>
                {update.isPending ? '正在保存…' : '保存英文对照'}
              </Button>
            </>
          )}
      {notice ? <p role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="skill-translations-notice" className="text-sm"
        style={{ color: notice.tone === 'error' ? 'var(--error)' : 'var(--success)' }}>{notice.text}</p> : null}
    </section>
  );
}
