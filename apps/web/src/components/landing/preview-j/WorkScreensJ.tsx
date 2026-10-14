/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { ReactNode } from 'react';
import { Check, FileText, Loader2, Sparkles } from 'lucide-react';
import library from '@/app/library/library.module.css';
import { UploadPanel } from '@/components/library/my-documents-view';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { J_WORK_SAMPLES as S, type WorkId } from '@/lib/landing/landing-copy-j-work';
import type { UploadItem } from '@/hooks/use-library-uploads';
import styles from './work-j.module.css';

const noop = () => undefined;
/** Marks a piece that arrives at phase `at`; CSS shows it once the window's phase has reached it. */
const at = (phase: number, step: number) => ({ 'data-at': step, 'data-shown': phase >= step ? '' : undefined });

/** One demo's window content at `phase` (0 → the scene's last phase). Everything is a picture (the window is inert). */
export function WorkScreenJ({ id, phase }: { id: WorkId; phase: number }) {
  const screens: Record<WorkId, ReactNode> = {
    topics: <Topics phase={phase} />, method: <Method phase={phase} />, data: <Data phase={phase} />, money: <Money phase={phase} />,
    models: <Models phase={phase} />, library: <Library phase={phase} />, voice: <Voice phase={phase} />, publish: <Publish phase={phase} />,
  };
  return screens[id];
}

function User({ text, shown }: { text: string; shown: ReturnType<typeof at> }) {
  return <p className={styles.user} {...shown}>{text}</p>;
}
function Coach({ text, shown, children }: { text: string; shown: ReturnType<typeof at>; children?: ReactNode }) {
  return <div className={styles.coach} {...shown}><span>AI 教练</span><p>{text}</p>{children}</div>;
}
function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return <dl className={styles.rows}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Topics({ phase }: { phase: number }) {
  return (
    <div className={styles.chat}>
      <User text={S.topics.ask} shown={at(phase, 0)} />
      <Coach text={S.topics.reply} shown={at(phase, 1)}>
        <ol className={styles.topics}>
          {S.topics.items.map((item, index) => (
            <li key={item.title} {...at(phase, index === 0 ? 1 : 2)}><b>{item.title}</b><span>{item.why}</span></li>
          ))}
        </ol>
        <Button size="sm" tabIndex={-1} className={styles.adopt} data-done={phase >= 3 || undefined}>
          {phase >= 3 ? <><Check size={14} aria-hidden="true" />{S.topics.adopted}</> : S.topics.adopt}
        </Button>
      </Coach>
    </div>
  );
}

function Method({ phase }: { phase: number }) {
  return (
    <div className={styles.chat}>
      <User text={S.method.ask} shown={at(phase, 0)} />
      <Coach text={S.method.reply} shown={at(phase, 1)}>
        <dl className={styles.rows}>
          {S.method.rows.map(([label, value], index) => (
            <div key={label} {...at(phase, Math.min(3, 1 + index))}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      </Coach>
    </div>
  );
}

function Data({ phase }: { phase: number }) {
  return (
    <div className={styles.chat}>
      <User text={S.data.ask} shown={at(phase, 0)} />
      <ul className={styles.fetch} {...at(phase, 1)}>
        {S.data.fetching.map((line, index) => (
          <li key={line} data-done={phase >= 2 || (phase >= 1 && index === 0) || undefined}>
            {phase >= 2 || (phase >= 1 && index === 0) ? <Check size={14} aria-hidden="true" /> : <Loader2 size={14} aria-hidden="true" />}{line}
          </li>
        ))}
      </ul>
      <Coach text={S.data.title} shown={at(phase, 2)}>
        <div className={styles.trend}>
          <span>{S.data.trend}</span>
          <svg viewBox="0 0 200 50" preserveAspectRatio="none" aria-hidden="true">
            <path className={styles.trendFill} d="M0 46 C 40 44 70 40 100 32 S 160 14 200 6 L 200 50 L 0 50 Z" />
            <path className={styles.trendLine} d="M0 46 C 40 44 70 40 100 32 S 160 14 200 6" />
          </svg>
        </div>
        <div {...at(phase, 3)}><Rows rows={S.data.rows} /></div>
      </Coach>
    </div>
  );
}

function Money({ phase }: { phase: number }) {
  return (
    <div className={styles.report}>
      <p className={styles.reportTitle}><FileText size={15} aria-hidden="true" />{S.money.title}</p>
      <h4 {...at(phase, 0)}>{S.money.chapter}</h4>
      <p className={styles.verdict} {...at(phase, 1)}>{S.money.verdict}</p>
      <ol className={styles.routes} {...at(phase, 2)}>
        {S.money.routes.map(route => <li key={route.text}><b>{route.step}</b>{route.text}</li>)}
      </ol>
      <p className={styles.reportNote} {...at(phase, 2)}>{S.money.note}</p>
    </div>
  );
}

function Models({ phase }: { phase: number }) {
  const done = Math.min(S.models.steps.length, phase <= 0 ? 0 : phase === 1 ? 2 : S.models.steps.length);
  return (
    <div className={styles.chat}>
      <User text={S.models.ask} shown={at(phase, 0)} />
      <ul className={styles.fetch} {...at(phase, 1)}>
        {S.models.steps.map((step, index) => (
          <li key={step} data-done={index < done || undefined}>
            {index < done ? <Check size={14} aria-hidden="true" /> : <Loader2 size={14} aria-hidden="true" />}{step}
          </li>
        ))}
      </ul>
      <Coach text={S.models.reply} shown={at(phase, 3)}>
        <ol className={styles.titles}>{S.models.titles.map(title => <li key={title}>{title}</li>)}</ol>
      </Coach>
    </div>
  );
}

function Library({ phase }: { phase: number }) {
  return (
    <div className={styles.library}>
      <div className={library.page}>
        <header className={library.header}><span className={styles.libraryTitle}>资料库</span></header>
        <nav className={library.tabs} aria-label="资料库分类">
          <button type="button" role="tab" aria-selected tabIndex={-1}>选题与稿件</button>
          <button type="button" role="tab" aria-selected={false} tabIndex={-1}>我的文档</button>
        </nav>
        <p className={library.intro}>{S.library.intro}</p>
        <div className={styles.libraryRows}>
          {S.library.items.map(item => (
            <article key={item.title} className={library.item} {...(item.fresh ? at(phase, 1) : at(phase, 0))} data-fresh={item.fresh || undefined}>
              <div className={library.itemOpen}>
                <span><strong>{item.title}</strong><small>{item.type}</small></span>
                <span>{S.library.account.platform}<small>{S.library.account.name}</small></span>
                <span>{item.draft}</span>
                <span>{item.published}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className={styles.libraryChat} {...at(phase, 2)}>
        <p className={styles.user}>{S.library.chat}</p>
        <div className={styles.coach}><span>AI 教练</span><p>{S.library.reply}</p></div>
      </div>
    </div>
  );
}

function Voice({ phase }: { phase: number }) {
  const status = (index: number): UploadItem['status'] => (phase >= 2 ? 'done' : phase >= 1 ? (index === 0 ? 'done' : 'transfer') : 'extract');
  const uploads: UploadItem[] = S.voice.files.map((filename, index) => ({
    key: filename, filename, purpose: 'authored', status: status(index), progress: 0.6,
  }));
  return (
    <div className={styles.voice}>
      <div className={styles.upload}>
        <UploadPanel uploadEnabled spaceKnown usedBytes={0} capacityBytes={500_000_000} uploads={uploads}
          onAdd={noop} onRetry={noop} onDismiss={noop} />
      </div>
      <Coach text={S.voice.title} shown={at(phase, 2)}>
        <Rows rows={S.voice.rows} />
      </Coach>
      <div className={styles.compare} {...at(phase, 3)}>
        <p><span>{S.voice.beforeLabel}</span>{S.voice.before}</p>
        <p><span><Sparkles size={13} aria-hidden="true" />{S.voice.afterLabel}</span>{S.voice.after}</p>
      </div>
    </div>
  );
}

function Publish({ phase }: { phase: number }) {
  return (
    <div className={styles.publish}>
      <p className={styles.post}><FileText size={15} aria-hidden="true" />{S.publish.post}<span>已定稿</span></p>
      <ul>
        {S.publish.platforms.map((platform, index) => (
          <li key={platform.name}><Checkbox checked={platform.on && phase >= (index === 0 ? 0 : 1)} tabIndex={-1} />{platform.name}
            {phase >= 2 && platform.on ? <em>已发布</em> : null}</li>
        ))}
      </ul>
      <Button size="sm" tabIndex={-1} className={styles.send} data-done={phase >= 2 || undefined}>
        {phase >= 2 ? <><Check size={14} aria-hidden="true" />{S.publish.done}</> : S.publish.action}
      </Button>
    </div>
  );
}
