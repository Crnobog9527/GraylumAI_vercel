/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { findScene, type SceneCard, type SceneLine } from '@/components/landing/preview-g/scenes';
import { J_SCENES } from '@/lib/landing/landing-copy-j';
import { FLOW_NOTE_LABEL, type FlowStep } from '@/lib/landing/landing-flow';
import { cn } from '@/lib/utils';
import styles from './sections-j.module.css';
import page from './j.module.css';

/**
 * After the story: the product's other everyday scenes — the library that remembers you, writing in your voice,
 * publishing, the weekly review — each with its own short conversation in the workbench's look (the same scripted,
 * made-up case as the demo, labelled 示例) beside the step's own copy. Steps switched off by the landing flags
 * drop out with their scene.
 */
export function ScenesJ({ steps }: { steps: readonly FlowStep[] }) {
  const shown = J_SCENES.steps.map(id => steps.find(step => step.id === id)).filter((step): step is FlowStep => Boolean(step));
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="scenes-title" className={page.section}>
      <div className={page.wrap}>
        <div className={page.sectionHead}>
          <h2 id="scenes-title" className={page.display}>
            {J_SCENES.title.split(/(?<=，)/).map(part => <span key={part} className={styles.phrase}>{part}</span>)}
          </h2>
          <p className={page.lede}>{J_SCENES.lede}</p>
        </div>
        <ol className={styles.scenes}>
          {shown.map((step, index) => {
            const scene = findScene(step.id);
            return (
              <li key={step.id} className={styles.scene} data-flip={index % 2 === 1 || undefined}>
                <div className={styles.sceneText}>
                  <h3>{step.title}</h3>
                  <p className={styles.sceneDemo}>{step.demo}</p>
                  <p className={styles.sceneNote}><b>{FLOW_NOTE_LABEL}</b>{step.note}</p>
                </div>
                <div className={styles.sceneWindow} aria-label={`${step.title}：示例对话`}>
                  <p className={styles.sceneBar}><span>{DEMO_LABEL}</span>{scene?.context ?? step.title}</p>
                  <div className={styles.sceneLog}>
                    {(scene?.lines ?? []).map((line, order) => <Line key={order} line={line} />)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function Line({ line }: { line: SceneLine }) {
  return (
    <div className={cn(styles.line, line.role === 'user' ? styles.lineUser : styles.lineCoach)}>
      <span>{line.role === 'user' ? '你' : 'AI 教练'}</span>
      <p>{line.text}</p>
      {line.card ? <Card card={line.card} /> : null}
    </div>
  );
}

function Card({ card }: { card: SceneCard }) {
  if (card.type === 'chips') {
    return <div className={styles.lineCard}><b>{card.title}</b><p className={styles.chips}>{card.items.map(item => <i key={item}>{item}</i>)}</p></div>;
  }
  if (card.type === 'outline') {
    return <div className={styles.lineCard}><b>{card.title}</b><ol>{card.items.map(item => <li key={item}>{item}</li>)}</ol></div>;
  }
  if (card.type === 'sheet') {
    return (
      <div className={styles.lineCard}>
        <b>{card.title}</b>
        <dl>{card.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </div>
    );
  }
  return null;
}
