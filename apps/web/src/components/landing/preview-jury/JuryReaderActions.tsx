/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef } from 'react';
import { CheckCircle2, Clock3 } from 'lucide-react';
import type { AdoptProposed, AdoptRecorded } from './jury-events';
import type { Adoption } from './use-adoption';
import { adoptErrorLabel } from './jury-adopt';
import styles from './jury-reader.module.css';
import { DisplayHeading } from '@/components/chat-display/display-heading';

/** The bar that stays at the bottom while choosing: how many chapters are chosen, later, and confirm. */
export function ChoiceBar({ adoption }: { adoption: Adoption }) {
  const { done, total, error, later, unconfirmed } = adoption;
  return (
    <div className={styles.bar}>
      <span className={styles.count} data-complete={done === total}>已选 {done}/{total}</span>
      <div className={styles.barActions}>
        <button type="button" className={styles.secondary} onClick={adoption.putOff}>先不选，稍后回来</button>
        <button type="button" className={styles.primary} onClick={adoption.propose} aria-disabled={done < total}
          disabled={adoption.busy}>确认</button>
      </div>
      {unconfirmed.length > 0 ? <p className={styles.error}>{unconfirmed.join('、')}选了修订版，还要勾选「确认这一章只改了表述」才算选完。</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {later ? <p className={styles.later}><Clock3 size={14} aria-hidden="true" />已选的章节会保存在这台设备上；你可以先去改草稿，回来接着选。</p> : null}
    </div>
  );
}

export function Done({ result }: { result: AdoptRecorded }) {
  return (
    <div className={styles.done} role="status">
      <CheckCircle2 size={20} aria-hidden="true" />
      {result.refused
        ? <p>这次修改没有采用成功：{adoptErrorLabel(result.refused)}</p>
        : result.versionId
        ? <p>新版本已生成：{result.adopted.length} 章采用修订版{result.kept.length ? `，其余 ${result.kept.length} 章没有修改` : ''}。之后的选题和写作会用新版本。</p>
        : result.declined || result.adopted.length > 0
          ? <p>你放弃了这次修改，报告和定位都没有变化；这次的选择已经记下。</p>
          : <p>你选择全部保留原文，报告没有变化；这次的选择已经记下。</p>}
    </div>
  );
}

/** Step 2: what adopting changes in the positioning, and the later steps re-confirmed with it, before anything changes. */
export function Review({ proposal, adoption }: { proposal: AdoptProposed; adoption: Adoption }) {
  const { changes, cascade } = proposal.diff;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Newer browsers return a promise from scrollIntoView; an effect must not return it.
    ref.current?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <section ref={ref} className={styles.review} aria-labelledby="jury-review-title">
      <DisplayHeading as="h4" id="jury-review-title">确认前先看一眼：采用 {proposal.adopted.length} 章会改动这些定位内容</DisplayHeading>
      {changes.length > 0 ? (
        <ul className={styles.diff}>
          {changes.map(item => (
            <li key={`${item.stepId}.${item.fieldId}`}>
              <span className={styles.diffWhere}>{item.stepTitle}：{item.fieldTitle}</span>
              <span className={styles.diffValues}><s>{item.before.value}</s><span aria-hidden="true">→</span><b>{item.after.value}</b></span>
            </li>
          ))}
        </ul>
      ) : <p className={styles.note}>这些章节只改了表述，定位内容不变。</p>}
      {cascade.length > 0 ? (
        <div className={styles.cascade}>
          <p>下面这些后续步骤建立在被改动的内容上，会和它们一起确认（内容本身不变）：</p>
          <ul>{cascade.map(step => <li key={step.stepId}>{step.stepTitle}（{step.fields.map(field => field.fieldTitle).join('、')}）</li>)}</ul>
        </div>
      ) : null}
      {adoption.error ? <p className={styles.error} role="alert">{adoption.error}</p> : null}
      <div className={styles.reviewActions}>
        <button type="button" className={styles.secondary} onClick={adoption.back}>返回修改选择</button>
        <button type="button" className={styles.secondary} disabled={adoption.busy} onClick={() => adoption.confirm('decline')}>放弃这次修改</button>
        <button type="button" className={styles.primary} disabled={adoption.busy} onClick={() => adoption.confirm('apply')}>确认采用，生成新版本</button>
      </div>
    </section>
  );
}
