/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';

/*
 * Local preview only (SampleJ renders this only when NODE_ENV is "development"; production builds drop it): the
 * Owner's "改字模式". Switched on, every piece of text on the page can be edited in place (pictures marked inert
 * stay as they are) and links stop navigating; changed text is outlined. "保存" sends each change as
 * 原文 → 新文 with its section to /api/dev/owner-edits, which writes it to a file on this machine; the developer
 * then carries the changes into the copy files and the page reloads with them.
 */

type Edit = { module: string; original: string; edited: string };
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

export function OwnerEditJ() {
  const [on, setOn] = useState(false);
  const [changed, setChanged] = useState(0);
  const [status, setStatus] = useState('');

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
      if (target.closest('a, button') && !target.closest('[data-owner-edit]')) event.preventDefault();
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

  const save = async () => {
    const nodes = changedNodes();
    const edits: Edit[] = nodes.map(node => ({
      module: moduleOf(node), original: node.dataset[ORIGINAL] ?? '', edited: node.textContent ?? '',
    }));
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
      setStatus(`已保存 ${edits.length} 处，正在同步到页面`);
    } catch {
      setStatus('没有保存成功，请再点一次保存');
    }
  };

  return (
    <div data-owner-edit=""
      className={'fixed bottom-4 left-4 z-[60] flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-2 py-1.5 '
        + 'text-[13px] shadow-lg'}>
      <style>{'[data-oe-changed]{outline:2px solid #ffbb17;outline-offset:2px;background:#fff8e1}[contenteditable]:hover{outline:1px dashed #bbb}'}</style>
      <button type="button" aria-pressed={on} onClick={() => setOn(value => !value)}
        className={on ? 'rounded-full bg-neutral-900 px-3 py-1 text-white' : 'rounded-full px-3 py-1'}>
        改字模式{on ? '：开' : '：关'}
      </button>
      {on ? (
        <>
          <span className="text-neutral-500">改了 {changed} 处</span>
          <button type="button" onClick={save} className="rounded-full bg-amber-400 px-3 py-1 font-medium text-neutral-900">保存</button>
        </>
      ) : null}
      {status ? <span role="status" className="text-neutral-600">{status}</span> : null}
    </div>
  );
}
