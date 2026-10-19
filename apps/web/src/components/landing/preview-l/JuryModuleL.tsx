/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { J_REPORT } from '@/lib/landing/landing-copy-j-takeover';
import { L_JURY } from '@/lib/landing/landing-copy-l-steps';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { JuryCircuitL } from './JuryCircuitL';
import styles from './jury-step-l.module.css';

/** The light runs down the line once per visit (kept in the page's memory: a reload plays it again). */
let flowedThisVisit = false;
const FLOW_MS = 800;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

type Line = { d: string; labelLeft: number };

/** Where the line runs, in the jury's own box: from under step one's "生成完整报告" to the label, then to "你的报告". */
function measure(root: HTMLElement): Line | null {
  const buttons = [...document.querySelectorAll<HTMLElement>('[aria-labelledby="step-one-title"] button')]
    .filter(button => button.textContent?.trim() === J_REPORT.generate);
  const button = buttons[buttons.length - 1];
  const label = root.querySelector<HTMLElement>('[data-jury-bridge]');
  const panel = root.querySelector<HTMLElement>('[data-jury-panel]');
  const node = root.querySelector<HTMLElement>('[data-jury-report]');
  if (!button || !label || !panel || !node) return null;
  const box = root.getBoundingClientRect();
  const from = button.getBoundingClientRect();
  const x = Math.round(from.left + from.width / 2 - box.left);
  const width = label.getBoundingClientRect().width;
  const labelLeft = Math.max(0, Math.min(box.width - width, x - width / 2));
  const top = label.offsetTop;
  const bottom = top + label.offsetHeight;
  let d = `M${x} ${Math.round(from.bottom - box.top + 4)} V${top}`;
  // Wide pages: on past the label, along the panel's top edge, down into the circuit's first node.
  if (window.matchMedia('(min-width: 900px)').matches) {
    const to = node.getBoundingClientRect();
    const nx = Math.round(to.left + to.width / 2 - box.left);
    const turn = panel.offsetTop + 18;
    d += ` M${x} ${bottom} V${turn} H${nx} V${Math.round(to.top - box.top)}`;
  }
  return { d, labelLeft };
}

/**
 * The jury, as step one's last beat (round twelve, Owner 2026-10-18: "用户在第一次看完生成完整报告的功能后，直接衔接评审团
 * 的功能介绍……要自然美观……不要省略得太多"), by /impeccable layout and animate. No longer a region of its own: under
 * step one's window a circuit line, in the jury circuit's own material, runs from the "生成完整报告" button to a label
 * (the bridge and the Gold tag), then into the jury's "你的报告"; under it the jury, its title a level below step one's:
 * on the left what it does (four points), one real-looking note (an example), when it is worth using and the link to
 * the jury's page; on the right the working circuit (JuryCircuitL, its timeline unchanged). The first time a visit
 * reaches it, a light runs down the line (0.8 seconds) and the circuit starts its first round as it arrives; reduced
 * motion: the line still, the circuit finished. Shown with the fusion flag only.
 */
export function JuryModuleL({ flags, href = L_JURY.href }: {
  flags: LandingFlags;
  /** Where "看评审团怎么工作" leads; null on the public home page until a public jury page exists (the demo is a preview page). */
  href?: string | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<Line | null>(null);
  const [flow, setFlow] = useState(false);
  const [started, setStarted] = useState(false);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    let frame = 0;
    const update = () => { frame = 0; setLine(measure(node)); };
    const later = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', later); window.removeEventListener('resize', later); };
  }, []);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    if (flowedThisVisit || reducedMotion() || typeof IntersectionObserver === 'undefined') { setStarted(true); return; }
    let timer = 0;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || flowedThisVisit) return;
      flowedThisVisit = true;
      observer.disconnect();
      setFlow(true);
      timer = window.setTimeout(() => setStarted(true), FLOW_MS);
    }, { threshold: 0.35 });
    observer.observe(node);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, []);

  if (!allOn(flags, L_JURY.needs)) return null;
  return (
    <div ref={root} className={styles.step} data-region="评审团">
      {line ? (
        <svg className={styles.line} aria-hidden="true">
          <path d={line.d} className={styles.wire} />
          <path d={line.d} pathLength={100} className={styles.spark} data-flow={flow || undefined} />
        </svg>
      ) : null}
      <p data-jury-bridge="" className={styles.bridge} style={line ? { marginLeft: line.labelLeft } : undefined}>
        {L_JURY.bridge}<span>{L_JURY.tier}</span>
      </p>
      <div data-jury-panel="" className={styles.panel}>
        <div className={styles.copy}>
          <h3 id="jury-title" className={styles.title}>
            {L_JURY.title.split(/(?<=，)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
          </h3>
          <ol className={styles.points}>
            {L_JURY.points.map(point => <li key={point.lead}><b>{point.lead}</b>{point.text}</li>)}
          </ol>
          <figure className={styles.example}>
            <figcaption><span className={styles.tag}>{L_JURY.example.tag}</span>{L_JURY.example.where}</figcaption>
            <blockquote>{L_JURY.example.note}</blockquote>
            <p className={styles.result}><Check size={15} aria-hidden="true" />{L_JURY.example.result}</p>
          </figure>
          <p className={styles.when}><b>{L_JURY.whenLabel}</b>{L_JURY.when}</p>
        </div>
        <div className={styles.circuit}><JuryCircuitL start={started} /></div>
        {href ? <Link href={href} className={styles.link}>{L_JURY.link}<ArrowRight size={16} aria-hidden="true" /></Link> : null}
      </div>
    </div>
  );
}
