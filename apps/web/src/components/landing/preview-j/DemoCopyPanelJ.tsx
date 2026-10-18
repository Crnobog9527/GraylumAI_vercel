/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { DemoCopyGroup } from './demo-copy-j';

/** Demo copy edits by path: the group they belong to, the text before, and the text now. */
export type DemoEdits = Record<string, { group: string; original: string; edited: string }>;

/**
 * Local edit mode only: the "演示文案" panel. Every piece of text the demos play, by module, each in its own box;
 * a changed box is marked, and the page's "保存" sends these changes together with the page's own.
 */
export function DemoCopyPanelJ({ groups, demo, setDemo, onClose }: {
  groups: DemoCopyGroup[]; demo: DemoEdits; setDemo: Dispatch<SetStateAction<DemoEdits>>; onClose: () => void;
}) {
  return (
    <aside aria-label="演示文案"
      className={'fixed bottom-20 right-4 top-20 z-[61] flex w-[min(440px,calc(100vw-32px))] flex-col rounded-2xl border '
        + 'border-neutral-300 bg-white shadow-2xl'}>
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <b className="text-[14px]">演示文案（动画里的字，演示已暂停）</b>
        <button type="button" onClick={onClose} className="text-neutral-500">收起</button>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {groups.map(group => (
          <details key={group.title} className="border-b border-neutral-100 py-2">
            <summary className="cursor-pointer text-[13.5px] font-semibold">
              {group.title}<span className="ml-2 text-[12px] font-normal text-neutral-400">{group.items.length} 段</span>
            </summary>
            <div className="mt-2 grid gap-2">
              {group.items.map(item => {
                const value = demo[item.path]?.edited ?? item.text;
                return (
                  <textarea key={item.path} value={value} rows={Math.min(5, Math.ceil(value.length / 26))}
                    onChange={event => {
                      const edited = event.target.value;
                      setDemo(current => ({
                        ...current, [item.path]: { group: group.title, original: current[item.path]?.original ?? item.text, edited },
                      }));
                    }}
                    className={'w-full resize-y rounded-lg border px-2 py-1.5 text-[13px] leading-relaxed '
                      + (value !== item.text ? 'border-amber-400 bg-amber-50' : 'border-neutral-200')} />
                );
              })}
            </div>
          </details>
        ))}
      </div>
      <footer className="border-t border-neutral-200 px-4 py-2 text-[12px] text-neutral-500">改完点下方的「保存」，和页面上的改动一起保存。</footer>
    </aside>
  );
}
