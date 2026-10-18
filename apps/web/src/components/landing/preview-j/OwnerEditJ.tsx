/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { DemoCopyPanelJ, type DemoEdits } from './DemoCopyPanelJ';
import { demoCopyGroups, type DemoCopyGroup } from './demo-copy-j';

/*
 * Local preview only (SampleJ renders this only when NODE_ENV is "development"; production builds drop it): the
 * Owner's "改字模式". Switched on, every piece of text on the page can be edited in place (pictures marked inert
 * stay as they are) and links stop navigating; changed text is outlined. "保存" sends each change as
 * 原文 → 新文 with its section to /api/dev/owner-edits, which writes it to a file on this machine; the developer
 * then carries the changes into the copy files and the page reloads with them.
 * While it is on, the demos pause (`data-owner-editing` on <html>) and "演示文案" lists every piece of text the
 * animations play, by module, so those can be edited too (Owner 2026-10-15); they are saved with the page's edits.
 * Sample L (Owner 2026-10-18) passes its own demo copy (`groups`) and `exportable`: "导出清单" downloads every change
 * saved for the page so far, plus any not yet saved, as one 原文 → 新文 list.
 */

type Edit = { module: string; original: string; edited: string };

/** Every saved change for the page, a change of a change folded into one (A → B, then B → C, is A → C). */
export function foldEdits(edits: readonly Edit[]): Edit[] {
  const out: Edit[] = [];
  for (const edit of edits) {
    const earlier = out.find(item => item.edited === edit.original && item.module === edit.module);
    if (earlier) earlier.edited = edit.edited;
    else out.push({ ...edit });
  }
  return out.filter(item => item.edited !== item.original);
}

/** The list the developer carries back into the copy files: numbered, by module, 原文 then 新文. */
export function editList(page: string, edits: readonly Edit[], at = new Date()) {
  const lines = [`改字清单 · ${page} · 导出于 ${at.toLocaleString('zh-CN')} · 共 ${edits.length} 处`, ''];
  edits.forEach((edit, index) => lines.push(`${index + 1}. 【${edit.module}】`, `原文：${edit.original}`, `新文：${edit.edited}`, ''));
  return lines.join('\n');
}
const ORIGINAL = 'oeOriginal';
/** Read from the page each time, never cached: re-renders and dev double-mounting cannot desync the count. */
const changedNodes = () => [...document.querySelectorAll<HTMLElement>('[data-oe-changed]')];

function textLeaves(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,li,blockquote,figcaption,span,b,a,dt,dd,button,small,label')]
    .filter(node => !node.closest('[inert],[data-owner-edit],[aria-hidden="true"] svg'))
    .filter(node => [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()));
}
function moduleOf(node: HTMLElement) {
  const section = node.closest('section, header, footer, nav');
  if (!section) return '页面';
  if (section.tagName === 'HEADER') return '页头';
  if (section.tagName === 'FOOTER') return '页脚';
  return section.querySelector('h1, h2')?.textContent?.trim() || section.getAttribute('aria-label') || '页面';
}

export function OwnerEditJ({ groups: loadGroups = demoCopyGroups, exportable = false }: {
  groups?: () => DemoCopyGroup[]; exportable?: boolean;
} = {}) {
  const [on, setOn] = useState(false);
  const [changed, setChanged] = useState(0);
  const [status, setStatus] = useState('');
  const [panel, setPanel] = useState(false);
  // Demo copy edits by path: { group title, original, edited }.
  const [demo, setDemo] = useState<DemoEdits>({});
  const groups = useMemo(() => loadGroups(), [loadGroups]);
  const demoChanged = Object.values(demo).filter(item => item.edited !== item.original);

  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.ownerEditing = '';
    else delete root.dataset.ownerEditing;
    return () => { delete root.dataset.ownerEditing; };
  }, [on]);

  useEffect(() => {
    if (!on) return;
    const root = document.querySelector<HTMLElement>('[data-owner-edit-root]') ?? document.body;
    const leaves = textLeaves(root);
    const count = () => setChanged(changedNodes().length);
    const onInput = (event: Event) => {
      const node = event.target as HTMLElement;
      if (!node.dataset[ORIGINAL]) return;
      if ((node.textContent ?? '') !== node.dataset[ORIGINAL]) node.dataset.oeChanged = '';
      else delete node.dataset.oeChanged;
      count();
    };
    const stopLinks = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // Placing the caret in a link's or button's words must not follow it nor run its click (that could switch or
      // unmount what is being edited): this capture listener runs before React's, so stopping here stops both.
      if (target.closest('a, button') && !target.closest('[data-owner-edit]')) { event.preventDefault(); event.stopPropagation(); }
    };
    for (const node of leaves) {
      node.dataset[ORIGINAL] ??= node.textContent ?? '';
      node.setAttribute('contenteditable', 'plaintext-only');
    }
    count();
    root.addEventListener('input', onInput);
    document.addEventListener('click', stopLinks, true);
    return () => {
      for (const node of leaves) node.removeAttribute('contenteditable');
      root.removeEventListener('input', onInput);
      document.removeEventListener('click', stopLinks, true);
    };
  }, [on]);

  // The changes not yet saved: the page's own, then the demo copy's.
  const pending = (nodes: HTMLElement[]): Edit[] => [
    ...nodes.map(node => ({ module: moduleOf(node), original: node.dataset[ORIGINAL] ?? '', edited: node.textContent ?? '' })),
    ...Object.entries(demo).filter(([, item]) => item.edited !== item.original)
      .map(([path, item]) => ({
        module: `演示文案 · ${item.group} · ${path}`.slice(0, 200), original: item.original, edited: item.edited,
      })),
  ];
  const save = async () => {
    const nodes = changedNodes();
    const edits = pending(nodes);
    if (!edits.length) { setStatus('还没有改动'); return; }
    setStatus('保存中…');
    try {
      const response = await fetch('/api/dev/owner-edits', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: window.location.pathname, edits }),
      });
      if (!response.ok) throw new Error(String(response.status));
      for (const node of nodes) {
        node.dataset[ORIGINAL] = node.textContent ?? '';
        delete node.dataset.oeChanged;
      }
      setChanged(0);
      setDemo(current => Object.fromEntries(Object.entries(current).map(([path, item]) => [path, { ...item, original: item.edited }])));
      setStatus(`已保存 ${edits.length} 处，正在同步到页面`);
    } catch {
      setStatus('没有保存成功，请再点一次保存');
    }
  };

  const exportList = async () => {
    setStatus('导出中…');
    try {
      const page = window.location.pathname;
      const response = await fetch(`/api/dev/owner-edits?page=${encodeURIComponent(page)}`);
      if (!response.ok) throw new Error(String(response.status));
      const { saves } = await response.json() as { saves: { edits: Edit[] }[] };
      const unsaved = pending(changedNodes());
      const edits = foldEdits([...saves.flatMap(item => item.edits), ...unsaved]);
      if (!edits.length) { setStatus('还没有改动可以导出'); return; }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([editList(page, edits)], { type: 'text/plain;charset=utf-8' }));
      link.download = `改字清单-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.txt`;
      link.click();
      URL.revokeObjectURL(link.href);
      setStatus(`已导出 ${edits.length} 处${unsaved.length ? `（其中 ${unsaved.length} 处还没保存，记得点保存）` : ''}`);
    } catch {
      setStatus('没有导出成功，请再点一次');
    }
  };

  return (
    <div data-owner-edit=""
      className={'fixed bottom-4 left-4 z-[60] flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-2 py-1.5 '
        + 'text-[13px] shadow-lg'}>
      {/* Its own colours: mounted beside a page (sample L), it would otherwise take the site's dark theme. */}
      <style>{'[data-oe-changed]{outline:2px solid #ffbb17;outline-offset:2px;background:#fff8e1}[contenteditable]:hover{outline:1px dashed #bbb}'
        + '[data-owner-edit]{color:#171717}[data-owner-edit] :not([class*="border-amber"]){border-color:#e5e5e5}'}</style>
      <button type="button" aria-pressed={on} onClick={() => setOn(value => !value)}
        className={on ? 'rounded-full bg-neutral-900 px-3 py-1 text-white' : 'rounded-full px-3 py-1'}>
        改字模式{on ? '：开' : '：关'}
      </button>
      {on ? (
        <>
          <span className="text-neutral-500">改了 {changed + demoChanged.length} 处</span>
          <button type="button" aria-expanded={panel} onClick={() => setPanel(value => !value)}
            className="rounded-full border border-neutral-300 px-3 py-1">演示文案</button>
          <button type="button" onClick={save} className="rounded-full bg-amber-400 px-3 py-1 font-medium text-neutral-900">保存</button>
          {exportable ? (
            <button type="button" onClick={exportList} className="rounded-full border border-neutral-300 px-3 py-1">导出清单</button>
          ) : null}
        </>
      ) : null}
      {status ? <span role="status" className="text-neutral-600">{status}</span> : null}
      {on && panel ? <DemoCopyPanelJ groups={groups} demo={demo} setDemo={setDemo} onClose={() => setPanel(false)} /> : null}
    </div>
  );
}
