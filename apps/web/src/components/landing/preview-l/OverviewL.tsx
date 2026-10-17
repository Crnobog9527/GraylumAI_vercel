/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties, ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { L_SAMPLES_REDO } from '@/lib/landing/landing-copy-l-samples';
import type { SampleOverview } from '@/lib/landing/sample-reports/overview';
import own from './samples-l.module.css';
import styles from './overview-l.module.css';

/** A follower count as the report writes it ("约 1.93 万", "182,665", "订阅 15,200") as a number, only to size its bar. */
export function countOf(text: string | null): number | null {
  const found = text?.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(万)?/);
  if (!found) return null;
  return Number(found[1]) * (found[2] ? 10_000 : 1);
}
const shareOf = (text: string | null) => { const found = text?.match(/(\d+(?:\.\d+)?)\s*%/); return found ? Number(found[1]) : null; };

/**
 * The sample report dialog's overview (Owner 2026-10-17, round five: "让用户 15 秒就能看懂……尽可能地让报告内容可视化"):
 * what the report decided for this person, drawn rather than told. Top to bottom: who, the one-sentence position, the
 * risk the coach raised, who it is for and when they buy, where to post, the benchmark accounts as bars of their
 * followers (other figures only where the report gives them), the content mix, the money funnel, the first 30 days,
 * the numbers to watch and this week's first steps. Every figure is the report's own text; a missing one is not drawn.
 * A summary drawn for the page, not a product screen: it carries 示意.
 */
export function OverviewL({ data }: { data: SampleOverview }) {
  const copy = L_SAMPLES_REDO.overview;
  const counts = data.benchmarks.map(item => countOf(item.followers));
  const most = Math.max(1, ...counts.map(count => count ?? 0));
  const pillars = data.contentPillars.map(item => ({ ...item, value: shareOf(item.share) }));
  return (
    <section className={styles.overview} aria-label={copy.title}>
      <header className={styles.head}>
        <p className={styles.who}><b>{data.persona.label}</b><span className={own.sketch}>{copy.sketch}</span></p>
        <p className={styles.whoLine}>{data.persona.who}</p>
        <p className={styles.position}>{data.positioning}</p>
      </header>

      {data.riskAlert ? (
        <div className={own.risk} role="note">
          <p className={own.riskLabel}><TriangleAlert size={16} aria-hidden="true" />{copy.risk}</p>
          <p className={own.riskText}>{data.riskAlert.headline}</p>
          {data.riskAlert.why.length ? <ul className={styles.why}>{data.riskAlert.why.map(item => <li key={item}>{item}</li>)}</ul> : null}
        </div>
      ) : null}

      <div className={styles.pair}>
        <Block title={copy.audience}>
          <ul className={styles.people}>
            {data.audience.map(item => <li key={item.name}><b>{item.name}</b><span>{item.trigger}</span></li>)}
          </ul>
        </Block>
        <Block title={copy.platform}>
          <p className={styles.main}>{data.platform.main}</p>
          {data.platform.support.length ? <p className={styles.support}>{copy.support}：{data.platform.support.join('、')}</p> : null}
          <p className={styles.small}>{data.platform.why}</p>
        </Block>
      </div>

      {data.benchmarks.length ? (
        <Block title={copy.benchmarks}>
          <ul className={styles.bars}>
            {data.benchmarks.map((item, index) => {
              const count = counts[index];
              const facts = [
                [copy.medianViews, item.medianViews], [copy.engagementRate, item.engagementRate], [copy.updateFreq, item.updateFreq],
              ].filter((fact): fact is [string, string] => Boolean(fact[1]));
              return (
                <li key={item.id}>
                  <p className={styles.barName}><b>{copy.benchmark(item.id)}</b><span>{item.type}</span></p>
                  {item.followers ? (
                    <div className={styles.barRow}>
                      {count ? <i className={styles.bar} style={{ '--w': `${Math.max(4, (count / most) * 100)}%` } as CSSProperties} /> : null}
                      <span>{copy.followers} {item.followers}</span>
                    </div>
                  ) : null}
                  {facts.length ? <p className={styles.facts}>{facts.map(([label, value]) => <span key={label}>{label} {value}</span>)}</p> : null}
                  <p className={styles.small}>{copy.learn}：{item.learn}</p>
                </li>
              );
            })}
          </ul>
          <p className={styles.source}>{data.sourceNote}</p>
        </Block>
      ) : null}

      <div className={styles.pair}>
        <Block title={copy.differentiation}><p className={styles.text}>{data.differentiation}</p></Block>
        <Block title={copy.threePiece}>
          <p className={styles.text}><b>{data.threePiece.name}</b></p>
          <p className={styles.small}>{data.threePiece.bio}</p>
        </Block>
      </div>

      {pillars.some(item => item.value !== null) ? (
        <Block title={copy.pillars}>
          <div className={styles.mix} role="img" aria-label={pillars.map(item => `${item.name} ${item.share ?? ''}`).join('，')}>
            {pillars.filter(item => item.value !== null).map((item, index) => (
              <i key={item.name} data-tone={index} style={{ flexGrow: item.value ?? 0 } as CSSProperties} />
            ))}
          </div>
          <ul className={styles.mixLegend}>
            {pillars.map((item, index) => <li key={item.name} data-tone={index}>{item.name}{item.share ? <b>{item.share}</b> : null}</li>)}
          </ul>
        </Block>
      ) : null}

      <Block title={copy.funnel}>
        <ol className={styles.funnel}>
          {data.funnel.map((item, index) => (
            <li key={item.layer} style={{ '--n': index, '--of': data.funnel.length } as CSSProperties}>
              <b>{item.layer}</b><span>{item.offer}</span>{item.price ? <em>{item.price}</em> : null}
            </li>
          ))}
        </ol>
      </Block>

      <Block title={copy.plan30}>
        <ol className={styles.weeks}>
          {data.plan30.map(item => <li key={item.week}><b>{copy.week(item.week)}</b><span>{item.focus}</span></li>)}
        </ol>
      </Block>

      <div className={styles.pair}>
        <Block title={copy.metrics}>
          <ul className={styles.chips}>{data.metricsToWatch.map(item => <li key={item}>{item}</li>)}</ul>
        </Block>
        <Block title={copy.first} todo>
          <ul className={styles.todo}>
            {data.firstStep.map(item => <li key={item}><span className={own.box} aria-hidden="true" />{item}</li>)}
          </ul>
        </Block>
      </div>
    </section>
  );
}

function Block({ title, todo = false, children }: { title: string; todo?: boolean; children: ReactNode }) {
  return (
    <section className={styles.block} data-todo={todo || undefined}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}
