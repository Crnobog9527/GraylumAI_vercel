/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Languages } from 'lucide-react';
import { REPLY_LOCALE_LABELS, REPLY_LOCALES, replyLocale } from '@repo/api/src/shared/replyLanguage';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSetReplyLanguage } from '@/hooks/use-set-reply-language';
import { trpc } from '@/trpc/client';

const SHORT = { 'zh-Hans': '简', 'zh-Hant': '繁', en: 'EN' } as const;

/**
 * CHAT-LANGUAGE (Owner 2026-10-25): the language switch on the right of the signed-in top bars, the only place the AI reply
 * language is changed ("在顶部导航栏的右边有语言切换就可以了"). The interface itself stays in Simplified Chinese for now,
 * which the menu says in one line, with what the setting does.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const profile = trpc.user.getUserProfile.useQuery();
  const { shown, choose, saving, failed } = useSetReplyLanguage(profile.data?.reply_language);
  if (!shown) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`语言：${REPLY_LOCALE_LABELS[shown]}`}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${className ?? ''}`}>
          <Languages aria-hidden="true" className="h-4 w-4" /><span>{SHORT[shown]}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>语言</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={shown} onValueChange={value => {
          const parsed = replyLocale.safeParse(value);
          if (parsed.success) choose(parsed.data);
        }}>
          {REPLY_LOCALES.map(locale => (
            <DropdownMenuRadioItem key={locale} value={locale} disabled={saving}>{REPLY_LOCALE_LABELS[locale]}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-2 pb-1 pt-2 text-xs leading-snug opacity-70">
          只影响 AI 回复语言，界面仍是简体中文；对话里明确要别的语言时那一次按你说的，改完从下一条回复起生效。
        </p>
        {failed && <p role="alert" className="px-2 pb-1 text-xs" style={{ color: 'var(--color-error)' }}>没有保存成功，请稍后再试。</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
