/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import page from '@/components/landing/preview-j/j.module.css';
import type { LandingData } from '@/components/landing/preview-j/SampleJ';
import { PlanCardsMNO } from '@/components/landing/preview-mno/PlanCardsMNO';
import { J_FINAL } from '@/lib/landing/landing-copy-j';
import { L_CARE } from '@/lib/landing/landing-copy-l';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { O_STATIONS } from './copy-o';
import { StationO } from './RouteO';
import styles from './o.module.css';

/**
 * Region 5, a station without a name: sample L's list of worries, each a white card with the gold station mark — the
 * worry, then what the coach does behind it; two columns where they fit. An item whose capability is off is left out.
 */
export function CareO({ flags, station }: { flags: LandingFlags; station: string }) {
  const items = visibleItems(flags, L_CARE.items);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="care-title" className={styles.section} data-region="不用操心的事">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <StationO n={station} />
          <h2 id="care-title" className={styles.title}>{L_CARE.title}</h2>
        </div>
        <ul className={styles.care}>
          {items.map(item => (
            <li key={item.worry} className={styles.card}>
              <b>{item.worry}</b>
              <span>{item.does}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Station "从这里出发": the plan cards (the shared PlanCardsMNO: Gold recommended and most prominent, "先聊后买" right
 * under the cards and their buttons), restyled through this sample's root class. Not a region of its own: the cards
 * carry "会员方案" and the guarantee "先聊后买".
 */
export function PlansO({ data, membershipHref, station }: { data: LandingData; membershipHref: string; station: string }) {
  if (data.pricing.cards.length === 0) return null;
  return (
    <section aria-label={O_STATIONS.price} className={styles.plansSection}>
      <div className={styles.wrap}>
        <div className={styles.head}><StationO n={station} label={O_STATIONS.price} /></div>
        <div className={styles.plans}>
          <PlanCardsMNO cards={data.pricing.cards} yearlyBadge={data.pricing.yearlyBadge} showResult={data.showResult}
            membershipHref={membershipHref} risk={data.risk} />
        </div>
      </div>
    </section>
  );
}

/** The close, the route's end (station 10): sample L's close, the same words, button and free-trial note. */
export function FinalO({ freeTrial }: { freeTrial: boolean }) {
  return (
    <section aria-labelledby="final-title" className={styles.section} data-region="结尾行动">
      <div className={styles.wrap}>
        <div className={styles.final}>
          <div className={styles.head}>
            <StationO n={O_STATIONS.end} />
            <h2 id="final-title" className={styles.title}>{J_FINAL.title}</h2>
          </div>
          <p className={styles.lede}>{J_FINAL.line}</p>
          <Link href={SIGNUP_CTA_HREF} className={page.pill}>{J_FINAL.cta}<ArrowRight size={18} aria-hidden="true" /></Link>
          {freeTrial ? <p className={styles.finalNote}>{J_FINAL.note}</p> : null}
        </div>
      </div>
    </section>
  );
}
