/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { CompareJ } from '@/components/landing/preview-j/CompareJ';
import type { PageExtras } from '@/components/landing/preview-j/extras-j';
import { PriceJ } from '@/components/landing/preview-j/PriceJ';
import type { LandingData } from '@/components/landing/preview-j/SampleJ';
import { FaqJ, FinalJ } from '@/components/landing/preview-j/SectionsJ';
import { SiteFooterJ } from '@/components/landing/preview-j/SiteFooterJ';
import { SiteHeaderJ } from '@/components/landing/preview-j/SiteHeaderJ';
import { VoiceWallJ } from '@/components/landing/preview-j/VoiceWallJ';
import page from '@/components/landing/preview-j/j.module.css';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { CareL } from '@/components/landing/preview-l/CareL';
import { SamplesMarqueeM } from './SamplesMarqueeM';
import { PlanCardsMNO } from '@/components/landing/preview-mno/PlanCardsMNO';
import { StickyCtaMNO } from '@/components/landing/preview-mno/StickyCtaMNO';
import { K_GOLD_LINE, K_PRICE_TERMS } from '@/lib/landing/landing-copy-k';
import { L_COMPARE_NEXT, L_COMPARE_PICKS, L_COMPARE_TITLE, L_NOTE_REGIONS, L_OPS } from '@/lib/landing/landing-copy-l';
import { allOn, visibleItems } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { HeroM } from './HeroM';
import { OpsM } from './OpsM';
import { RootM } from './RootM';
import styles from './m.module.css';

const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'] as const;

/**
 * Style sample M, direction H「产品主导」(Owner 2026-10-17): sample L's content and order on a white page with faint grey
 * bands, led by the real product. On a computer one product window stays fixed beside the page and follows the scroll
 * (StageM): the positioning conversation by the first screen and the voices, the week's conversation by region 3, the
 * report by the sample reports and the worries; the comparison (its own two windows), price, FAQ and the close take
 * the full width, and the plan cards take the window's place by the price. Phones and reduced motion: each region's
 * own window in place. The shared conversion parts: the thin "免费和教练聊聊" bar after the first screen, a button at
 * least every two regions, the plan cards with Gold first and most prominent and "先聊后买" right under them.
 */
export function SampleM({ data, siteName, extras, membershipHref }: {
  data: LandingData; siteName: string; extras: PageExtras; membershipHref: string;
}) {
  const faqIds = new Set(data.faqGroups.flatMap(group => group.items.map(item => item.id)));
  const terms = faqIds.has(K_PRICE_TERMS.faqId) ? (
    <p className={k.terms}>
      <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.cancel}</a> · <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.refund}</a>
    </p>
  ) : null;
  const gold = allOn(extras.flags, K_GOLD_LINE.needs) ? <p className={k.gold}>{K_GOLD_LINE.text}</p> : null;
  return (
    <RootM className={cn(light.light, page.page, k.page, styles.root)} flags={extras.flags}>
      <nav aria-label="样稿切换" className={page.sampleBar}>
        <span>不公开的风格样稿（M：产品主导）</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'm' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <SiteHeaderJ siteName={siteName} />
      <StickyCtaMNO line={L_OPS.lede} />

      <main data-calm="" data-calm-windows="">
        <div className={styles.lane} data-scene="ask"><HeroM note={data.heroNote} flags={extras.flags} /></div>
        <div className={styles.lane} data-scene="ask"><VoiceWallJ notes={data.notes} open regions={L_NOTE_REGIONS} /></div>
        <div className={styles.lane} data-scene="ops"><OpsM steps={visibleItems(extras.flags, L_OPS.steps)} flags={extras.flags} /></div>
        {extras.showSamples ? <div className={styles.lane} data-scene="report"><SamplesMarqueeM /></div> : null}
        <div className={styles.lane} data-scene="report"><CareL flags={extras.flags} /></div>
        <div data-scene="none">
          <CompareJ title={L_COMPARE_TITLE} picks={L_COMPARE_PICKS} next={L_COMPARE_NEXT} band="tint" />
          <div className={cn(k.wrap, styles.afterCompare)}><CtaK /></div>
        </div>
        <div className={styles.price} data-scene="none">
          <PriceJ proMonthly={data.pricing.proMonthly} rows={data.compareRows} calm plainTotal checked={false}
            after={terms || gold ? <>{terms}{gold}</> : undefined} />
          <div className={styles.plans}>
            <PlanCardsMNO cards={data.pricing.cards} yearlyBadge={data.pricing.yearlyBadge} showResult={data.showResult}
              membershipHref={membershipHref} risk={data.risk} />
          </div>
        </div>
        <div data-scene="none">
          <FaqJ groups={data.faqGroups} />
          <FinalJ freeTrial={allOn(extras.flags, ['signupGrant'])} />
        </div>
      </main>

      <SiteFooterJ />
    </RootM>
  );
}
