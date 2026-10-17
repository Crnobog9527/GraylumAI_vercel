/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { BASIS, REPORT_DATA_FIELDS } from "@repo/api/src/shared/reportDataSpec";
import type { ReportData } from "@repo/api/src/shared/reportData";
import { cn } from "@/lib/utils";
import { cellText } from "./report-data-table";
import { REPORT_VIEW_TEXT as T } from "./report-text";
import styles from "./report-view.module.css";

/**
 * Four of the report's five charts (REPORT-VISUAL §4; the benchmark bars are in report-benchmarks): the
 * first step, the audience cards, the funnel and the four-week timeline. Display only, drawn with plain
 * elements and CSS from the strategy data; every chart has a text alternative for screen readers.
 */

type Need<K extends keyof ReportData> = NonNullable<ReportData[K]>;

const GROUP = REPORT_DATA_FIELDS.audience.fields.groups.of.fields;
const FIT = GROUP.contentFit;
const label = (values: Record<string, string>, code: string) => values[code] ?? "";

export function FirstStepCard({ step }: { step: Need<"thisWeek">[number] }) {
  return (
    <div className={styles.firstStep}>
      <p className={styles.firstStepTitle}>{T.firstStep}</p>
      <p className={styles.firstStepAction}>{step.action}</p>
      <dl className={styles.firstStepPairs}>
        <div><dt>{T.why}</dt><dd>{step.why}</dd></div>
        <div><dt>{T.done}</dt><dd>{step.done}</dd></div>
      </dl>
    </div>
  );
}

/** Chart 1 in its chapter: every task of this week, the first one marked as the one to start with. */
export function ThisWeekList({ steps }: { steps: Need<"thisWeek"> }) {
  return (
    <div className={styles.block}>
      <p className={styles.blockTitle}>{T.thisWeek}</p>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={index} className={cn(index === 0 && styles.stepFirst)}>
            <p className={styles.stepAction}>{step.action}</p>
            <p className={styles.stepMeta}>{T.why}：{step.why}</p>
            <p className={styles.stepMeta}>{T.done}：{step.done}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Chart 2: one card per audience group with its two fit tags and where the information comes from. */
export function AudienceCards({ audience }: { audience: Need<"audience"> }) {
  return (
    <div className={styles.block}>
      <p className={styles.blockTitle}>{REPORT_DATA_FIELDS.audience.fields.groups.label}</p>
      <p className={styles.plain}>{REPORT_DATA_FIELDS.audience.fields.core.label}：{audience.core}</p>
      <ul className={styles.cards}>
        {audience.groups.map((group, index) => (
          <li key={index} className={styles.card}>
            <p className={styles.cardTitle}>{group.name}</p>
            <div className={styles.tags}>
              <span className={styles.tag}>{FIT.label}：{label(FIT.values, group.contentFit)}</span>
              <span className={styles.tag}>{GROUP.moneyFit.label}：
                {label(FIT.values, group.moneyFit)}</span>
              <span className={cn(styles.tag, styles.tagQuiet)}>{label(BASIS.values, group.basis)}</span>
            </div>
            <p className={styles.cardLine}><span>{GROUP.pain.label}</span>{group.pain}</p>
            <p className={styles.cardLine}><span>{GROUP.trigger.label}</span>{group.trigger}</p>
            {group.quote && <p className={styles.quote}>“{group.quote}”</p>}
            <details className={styles.more}>
              <summary>{T.audienceMore}</summary>
              <p className={styles.cardLine}><span>{GROUP.job.label}</span>{group.job}</p>
              <p className={styles.cardLine}><span>{GROUP.wallet.label}</span>{group.wallet}</p>
              <p className={styles.cardLine}><span>{GROUP.whyBuy.label}</span>{group.whyBuy}</p>
              <p className={styles.cardLine}><span>{GROUP.whyNot.label}</span>{group.whyNot}</p>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

const FUNNEL_FIELDS = REPORT_DATA_FIELDS.funnel.of.fields;
const FUNNEL_DETAIL = ["forWhom", "buyPoint", "filter", "whyFilter", "howToSell", "watch", "basis"] as const;

/** Chart 4: a funnel, wide at the top and narrower at each layer: what it sells, the price and its purpose. */
export function FunnelChart({ layers }: { layers: Need<"funnel"> }) {
  const step = layers.length > 1 ? 45 / (layers.length - 1) : 0;
  return (
    <figure className={styles.block}>
      <figcaption className={styles.blockTitle}>{REPORT_DATA_FIELDS.funnel.label}</figcaption>
      <ol className={styles.funnel} aria-label={layers.map(layer => `${layer.layer}：${layer.offer}，${layer.price}`).join("；")}>
        {layers.map((layer, index) => (
          <li key={index}>
            <div className={styles.funnelBar} style={{ width: `${100 - step * index}%` }}>
              <p className={styles.funnelName}>{layer.layer}<span>{layer.price}</span></p>
              <p className={styles.funnelOffer}>{layer.offer}</p>
              <p className={styles.funnelRole}>{layer.role}</p>
            </div>
            <details className={styles.more}>
              <summary>{T.layerDetail}</summary>
              <dl className={styles.pairs}>
                {FUNNEL_DETAIL.map(key => (
                  <div key={key}><dt>{FUNNEL_FIELDS[key].label}</dt><dd>{cellText(FUNNEL_FIELDS[key], layer[key])}</dd></div>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ol>
    </figure>
  );
}

const WEEK = REPORT_DATA_FIELDS.plan30.fields.weeks.of.fields;

/** Chart 5: the four weeks side by side (each week's focus, posts, metric and pass line), then the metrics list. */
export function Plan30Timeline({ plan }: { plan: Need<"plan30"> }) {
  const metrics = [...new Set(plan.weeks.map(week => week.watch))];
  return (
    <figure className={styles.block}>
      <figcaption className={styles.blockTitle}>{REPORT_DATA_FIELDS.plan30.label}</figcaption>
      <ol className={styles.timeline}>
        {plan.weeks.map((week, index) => (
          <li key={index} className={styles.week}>
            <p className={styles.weekNumber}>第 {week.week} 周</p>
            <p className={styles.weekPurpose}>{week.purpose}</p>
            <p className={styles.cardLine}><span>{WEEK.posts.label}</span>{week.posts}</p>
            <p className={styles.cardLine}><span>{WEEK.topics.label}</span>{week.topics}</p>
            <p className={styles.cardLine}><span>{WEEK.watch.label}</span>{week.watch}</p>
            <p className={cn(styles.cardLine, styles.passIf)}><span>{WEEK.passIf.label}</span>{week.passIf}</p>
            <p className={styles.cardLine}><span>{WEEK.reviewQuestion.label}</span>{week.reviewQuestion}</p>
          </li>
        ))}
      </ol>
      <div className={styles.metrics}>
        <p className={styles.blockTitle}>{T.metricsTitle}</p>
        <ul className={styles.list}>{metrics.map(metric => <li key={metric}>{metric}</li>)}</ul>
        {plan.day30Questions.length > 0 && <>
          <p className={styles.blockTitle}>{T.day30}</p>
          <ul className={styles.list}>{plan.day30Questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
        </>}
      </div>
    </figure>
  );
}
