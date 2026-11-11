/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { AsDemo } from '@/components/chat-display/display-heading';
import { cn } from '@/lib/utils';
import { DemoTag } from './DemoTag';
import styles from './flow-l.module.css';
import { useLoop } from './use-loop-l';

/** A picture of one module: what it shows `ms` into its loop (`null`: finished), and how long the loop is. */
export type FlowPicture = { totalMs: number; draw: (ms: number | null) => ReactNode };

/**
 * One module of region 3 (Owner 2026-11-11): its number and name, one line, and the picture, which plays by itself in a
 * loop while on screen (use-loop-l.ts) and is still, finished, in the server's HTML and under reduced motion. The
 * picture is an example of the product's own components, so it is inert and its headings are plain elements. A module
 * may end its line with one link to somewhere else on the page (`link`): the picture itself, looping, carries none.
 */
export function FlowModuleL({ number, name, line, picture, link }: {
  number: number; name: string; line: string; picture: FlowPicture; link?: { href: string; label: string };
}) {
  const frame = useRef<HTMLDivElement>(null);
  const { ms, round } = useLoop(frame, picture.totalMs);
  return (
    <li className={styles.module} data-region="流程模块">
      <h4 className={styles.name}><span className={styles.number} aria-hidden="true">{number}</span>{name}<DemoTag /></h4>
      <p className={styles.line}>
        {line}
        {link ? <a href={link.href} className={styles.more}>{link.label}<ArrowRight size={14} aria-hidden="true" /></a> : null}
      </p>
      <div ref={frame} className={styles.picture} inert>
        <div key={round} className={styles.round}><AsDemo>{picture.draw(ms)}</AsDemo></div>
      </div>
    </li>
  );
}

/** A step of region 3: its title, an optional line under it, its modules in a row. */
export function FlowStepL({ id, title, lede, first = false, children, after }: {
  id?: string; title: string; lede?: string; first?: boolean; children: ReactNode[]; after?: ReactNode;
}) {
  return (
    <div role="group" aria-label={id ? undefined : title} aria-labelledby={id} className={styles.step}
      data-first={first || undefined} data-region={title.slice(0, 3)}>
      <h3 id={id} className={styles.title}>{title}</h3>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
      <ol className={styles.grid} data-count={children.length}>{children}</ol>
      {after}
    </div>
  );
}

/**
 * What a picture holds: from its top, its newest part kept in view once it no longer fits (flow-l.module.css).
 * `anchor="top"` keeps its top in view instead, for a result whose first lines are the point (a table above its notes).
 */
export function Feed({ tone, anchor, children }: { tone?: 'sheet'; anchor?: 'top'; children: ReactNode }) {
  return <div className={styles.feed} data-tone={tone} data-anchor={anchor}><div>{children}</div></div>;
}

/** Something that has just arrived in a picture. */
export function Arrive({ when = true, className, children }: { when?: boolean; className?: string; children: ReactNode }) {
  return when ? <div className={cn(styles.arrive, className)}>{children}</div> : null;
}
