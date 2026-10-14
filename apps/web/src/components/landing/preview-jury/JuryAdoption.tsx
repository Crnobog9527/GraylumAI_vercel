/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock3 } from 'lucide-react';
import type { AdoptProposed, AdoptRecorded, JuryDetail, JurySeatNames } from './jury-events';
import {
  adoptErrorLabel, choosable, chosenCount, isComplete, mockConfirm, mockPropose, needsConfirm, setConfirmed, setUse, toChoices,
} from './jury-adopt';
import { useDraftChoices } from './use-draft-choices';
import { JuryChapter } from './JuryChapter';
import styles from './jury-results.module.css';

type Stale = 'none' | 'report' | 'proposal';

/**
 * Chapter choices in two steps, shaped after fusionReview.adopt and confirmAdoption (contract v6): choose per chapter,
 * then look at the field changes and the steps confirmed with them, then apply or decline. Mock calls only.
 */
export function JuryAdoption({ detail, names, quiet }: { detail: JuryDetail; names: JurySeatNames; quiet: number }) {
  const sections = detail.summary.sections;
  const shown = sections.filter(item => item.rulings.length > 0 || item.changed);
  const { state, setState, clear } = useDraftChoices(detail.reviewId);
  const [proposal, setProposal] = useState<AdoptProposed | null>(null);
  const [result, setResult] = useState<AdoptRecorded | null>(detail.adoption);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<Stale>('none');
  const [later, setLater] = useState(false);
  const total = choosable(sections).length;
  const done = chosenCount(state, sections);

  const propose = () => {
    if (stale === 'report') { setError(adoptErrorLabel('REPORT_REVISION_STALE')); return; }
    if (!isComplete(state, sections)) {
      const unconfirmed = choosable(sections).some(item => needsConfirm(item, state));
      setError(adoptErrorLabel(unconfirmed ? 'FUSION_ADOPTION_CONFIRM_REQUIRED' : 'FUSION_ADOPTION_INCOMPLETE'));
      return;
    }
    setError(null);
    const answer = mockPropose(sections, toChoices(state, sections));
    if (answer.state === 'recorded') { clear(); setResult(answer); } else setProposal(answer);
  };
  const confirm = (decision: 'apply' | 'decline') => {
    if (!proposal) return;
    if (decision === 'apply' && stale === 'proposal') {
      // The proposal the user saw is outdated: drop it, so the next look fetches and shows the new one.
      setProposal(null);
      setStale('none');
      setError(adoptErrorLabel('FUSION_ADOPTION_STALE'));
      return;
    }
    setError(null);
    clear();
    setResult(mockConfirm(proposal, decision));
  };

  return (
    <section className={styles.block} aria-labelledby="jury-chapters">
      <h3 id="jury-chapters">逐章意见和你的选择</h3>
      <p className={styles.blockNote}>
        改过的章节由你决定用修订版还是原文；没改的章节保留原文。选完后先看会改动哪些定位内容，再确认。
        {quiet > 0 ? `其余 ${quiet} 章评审团没有意见。` : ''}
      </p>
      {result ? null : (
        <label className={styles.prototypeSwitch}>
          原型：模拟提交被拒
          <select value={stale} onChange={event => setStale(event.target.value as Stale)}>
            <option value="none">不模拟</option>
            <option value="report">评审之后改过草稿</option>
            <option value="proposal">确认前内容有更新</option>
          </select>
        </label>
      )}
      <div className={styles.chapters}>
        {shown.map(section => (
          <JuryChapter key={section.section} section={section} names={names} state={state} locked={Boolean(result || proposal)}
            onUse={use => { setState(value => setUse(value, sections, section.section, use)); setError(null); }}
            onConfirm={confirmed => setState(value => setConfirmed(value, section.section, confirmed))} />
        ))}
      </div>

      {result ? <Done result={result} /> : proposal ? (
        <Review proposal={proposal} error={error} onConfirm={confirm} onBack={() => { setProposal(null); setError(null); }} />
      ) : (
        <div className={styles.bar}>
          <span className={styles.count}>已选 {done}/{total} 章</span>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {later ? <p className={styles.later}><Clock3 size={14} aria-hidden="true" />已选的章节会保存在这台设备上；你可以先去改草稿，回来接着选。</p> : null}
          <div className={styles.barActions}>
            <button type="button" className={styles.secondary} onClick={() => setLater(true)}>先不选，稍后回来</button>
            <button type="button" className={styles.primary} onClick={propose} aria-disabled={done < total}>下一步：看改动</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Done({ result }: { result: AdoptRecorded }) {
  return (
    <div className={styles.done} role="status">
      <CheckCircle2 size={20} aria-hidden="true" />
      {result.versionId
        ? <p>新版本已生成：{result.adopted.length} 章采用修订版{result.kept.length ? `，${result.kept.length} 章保留原文` : ''}。之后的选题和写作会用新版本。</p>
        : result.adopted.length > 0
          ? <p>你放弃了这次修改，报告和定位都没有变化；这次的选择已经记下。</p>
          : <p>你选择全部保留原文，报告没有变化；这次的选择已经记下。</p>}
    </div>
  );
}

/** Step 2: what adopting changes in the positioning, and the later steps re-confirmed with it, before anything changes. */
function Review({ proposal, error, onConfirm, onBack }: {
  proposal: AdoptProposed; error: string | null; onConfirm: (decision: 'apply' | 'decline') => void; onBack: () => void;
}) {
  const { changes, cascade } = proposal.diff;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Newer browsers return a promise from scrollIntoView; an effect must not return it.
    ref.current?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <section ref={ref} className={styles.review} aria-labelledby="jury-review-title">
      <h4 id="jury-review-title">确认前先看一眼：采用 {proposal.adopted.length} 章会改动这些定位内容</h4>
      {changes.length > 0 ? (
        <ul className={styles.diff}>
          {changes.map(item => (
            <li key={`${item.stepId}.${item.fieldId}`}>
              <span className={styles.diffWhere}>{item.stepTitle}：{item.fieldTitle}</span>
              <span className={styles.diffValues}><s>{item.before.value}</s><span aria-hidden="true">→</span><b>{item.after.value}</b></span>
            </li>
          ))}
        </ul>
      ) : <p className={styles.blockNote}>这些章节只改了表述，定位内容不变。</p>}
      {cascade.length > 0 ? (
        <div className={styles.cascade}>
          <p>下面这些后续步骤建立在被改动的内容上，会和它们一起确认（内容本身不变）：</p>
          <ul>{cascade.map(step => <li key={step.stepId}>{step.stepTitle}（{step.fields.map(field => field.fieldTitle).join('、')}）</li>)}</ul>
        </div>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.reviewActions}>
        <button type="button" className={styles.secondary} onClick={onBack}>返回修改选择</button>
        <button type="button" className={styles.secondary} onClick={() => onConfirm('decline')}>放弃这次修改</button>
        <button type="button" className={styles.primary} onClick={() => onConfirm('apply')}>确认采用，生成新版本</button>
      </div>
    </section>
  );
}
