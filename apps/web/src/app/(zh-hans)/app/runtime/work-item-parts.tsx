/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { SaveKind } from './work-turn-path';

/** The work item's choices in the transcript (V2-10b C2), worded as on the old workspace. */
export const TYPE_LABEL: Record<string, string> = { article: '文章', image_text: '图文', video: '视频' };

export function WorkTypeChoice({ disabled, onChoose }: { disabled: boolean; onChoose: (value: string) => void }) {
  return (
    <section className="rounded-xl border p-4" aria-label="确认内容类型">
      <h2>这条选题准备做成什么内容？</h2>
      <p>先确认形式，再一起细化重点和结构。</p>
      <div className="mt-3 flex gap-2">
        {Object.keys(TYPE_LABEL).map(value => (
          <Button key={value} disabled={disabled} onClick={() => onChoose(value)}>
            {TYPE_LABEL[value]}
          </Button>
        ))}
      </div>
    </section>
  );
}

/** CONTENT-CONVERSATION-2: the save buttons under a reply of the topic window, one per kind the item takes; a kind already saved
 *  from this reply shows its version and a link to the library instead. */
export function WorkSaveActions({ kinds, saved, href, disabled, onSave }: {
  kinds: ReadonlyArray<{ kind: SaveKind; label: string }>; saved: Partial<Record<SaveKind, number>>; href: string; disabled: boolean;
  onSave: (kind: SaveKind) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="保存这条回复">
      {kinds.map(({ kind, label }) =>
        saved[kind] !== undefined ? (
          <Link key={kind} className="text-sm underline" href={href}>
            已存为{label} · 第 {saved[kind]} 版 · 查看
          </Link>
        ) : (
          <Button key={kind} size="sm" variant="outline" disabled={disabled} onClick={() => onSave(kind)}>
            存为{label}
          </Button>
        )
      )}
    </div>
  );
}
