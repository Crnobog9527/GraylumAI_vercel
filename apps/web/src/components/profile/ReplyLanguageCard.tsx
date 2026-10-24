/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { REPLY_LOCALE_LABELS, REPLY_LOCALES, type ReplyLocale } from '@repo/api/src/shared/replyLanguage';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';

/**
 * CHAT-LANGUAGE (Owner 2026-10-24, A): the language every AI reply is written in. The interface itself stays in
 * Simplified Chinese for now (interface translation is a later task), which the card says next to the choice.
 */
export function ReplyLanguageCard({ language }: { language: ReplyLocale }) {
  const utils = trpc.useUtils();
  const [failed, setFailed] = useState(false);
  const save = trpc.user.setReplyLanguage.useMutation({
    onMutate: () => setFailed(false),
    onSuccess: () => utils.user.getUserProfile.invalidate(),
    onError: () => setFailed(true),
  });
  const shown = save.isPending && save.variables ? save.variables.language : language;
  return (
    <div className="mt-6 rounded-2xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <p id="reply-language-label" className="font-medium" style={{ color: 'var(--text-primary)' }}>语言</p>
      <p className="mt-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        AI 用这个语言和你对话、写内容和报告；你在对话里明确要别的语言时，那一次按你的要求。目前只影响 AI 回复语言，网站界面仍是简体中文。
      </p>
      <div role="radiogroup" aria-labelledby="reply-language-label" className="mt-4 flex flex-wrap gap-2">
        {REPLY_LOCALES.map(locale => (
          <Button
            key={locale}
            type="button"
            role="radio"
            aria-checked={shown === locale}
            size="sm"
            variant={shown === locale ? 'default' : 'outline'}
            disabled={save.isPending}
            onClick={() => { if (locale !== language) save.mutate({ language: locale }); }}
          >
            {REPLY_LOCALE_LABELS[locale]}
          </Button>
        ))}
        {save.isPending && <Loader2 aria-label="正在保存" className="h-4 w-4 animate-spin self-center" />}
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--color-error)' }}>
          语言设置没有保存成功，请稍后再试。
        </p>
      )}
      <p className="mt-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>改完后从下一条回复开始生效，正在生成的回复不变。</p>
    </div>
  );
}
