/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { CompareJ } from '@/components/landing/preview-j/CompareJ';
import { MotionJ } from '@/components/landing/preview-j/MotionJ';
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
import { PlanCardsMNO } from '@/components/landing/preview-mno/PlanCardsMNO';
import { StickyCtaMNO } from '@/components/landing/preview-mno/StickyCtaMNO';
import { HERO, RISK_REVERSAL } from '@/lib/landing/landing-copy';
import { J_FINAL } from '@/lib/landing/landing-copy-j';
import { K_GOLD_LINE, K_PRICE_TERMS } from '@/lib/landing/landing-copy-k';
import {
  L_COMPARE_NEXT, L_COMPARE_PICKS, L_COMPARE_STEPS, L_COMPARE_TITLE, L_NOTE_REGIONS, L_OPS, L_VOICE_FOLD,
} from '@/lib/landing/landing-copy-l';
import { allOn, visibleItems } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { CareL } from './CareL';
import { HeroL } from './HeroL';
import { OpsL } from './OpsL';
import { SamplesL } from './SamplesL';
import styles from './l.module.css';

const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] as const;

/**
 * Style sample L: sample K's second round (Owner 2026-10-17, after seeing K; K stays as it was, tagged
 * sample-k-round1-2026-10-17). The first screen's picture is what the coach does for you in three plain steps; every
 * voice shows, with its region; region 3 is daily operations, playing on by itself and clickable; the sample reports
 * move across the screen as cards; "不用你再操心" is a list of worries and what the coach does behind each; the
 * comparison is back in chat windows, each ending on what to do next; the usual ways' total stands whole.
 * Fixes of 2026-10-17 (Owner: keep L's look; tagged sample-l-before-fix-2026-10-17): the demos as the real product (the
 * work chat, the coach heads), price quieter with the plan cards (Gold first, 先聊后买 under its button), one button
 * wording with a sticky bar after the first screen (at the foot of a phone), a button at least every two regions, the
 * voice wall tighter on a phone, the sample row swiped on touch screens.
 */
export function SampleL({ data, siteName, extras, membershipHref }: {
  data: LandingData; siteName: string; extras: PageExtras; membershipHref: string;
}) {
  const faqIds = new Set(data.faqGroups.flatMap(group => group.items.map(item => item.id)));
  const terms = faqIds.has(K_PRICE_TERMS.faqId) ? (
    <p className={k.terms}>
      <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.cancel}</a> · <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.refund}</a>
    </p>
  ) : null;
  const gold = allOn(extras.flags, K_GOLD_LINE.needs) ? <p className={k.gold}>{K_GOLD_LINE.text}</p> : null;
  const riskLine = allOn(extras.flags, ['signupGrant']) ? <><b>{RISK_REVERSAL.title}</b>{J_FINAL.note}</> : null;
  return (
    <MotionJ className={cn(light.light, page.page, k.page)}>
      <nav aria-label="样稿切换" className={page.sampleBar}>
        <span>不公开的风格样稿（L：K 的第二轮）</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'l' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <SiteHeaderJ siteName={siteName} cta={HERO.primaryCta} />
      <StickyCtaMNO line={L_OPS.lede} phoneBottom hideHeaderCta />

      <main data-calm="">
        <HeroL note={data.heroNote} flags={extras.flags} />
        <VoiceWallJ notes={data.notes} open regions={L_NOTE_REGIONS} compact={L_VOICE_FOLD} after={<CtaK />} />
        <OpsL steps={visibleItems(extras.flags, L_OPS.steps)} flags={extras.flags} />
        {extras.showSamples ? <SamplesL /> : null}
        <CareL flags={extras.flags} />
        <CompareJ title={L_COMPARE_TITLE} picks={L_COMPARE_PICKS} next={L_COMPARE_NEXT} steps={L_COMPARE_STEPS} after={<CtaK />} />
        <PriceJ proMonthly={data.pricing.proMonthly} rows={data.compareRows} calm plainTotal checked={false} quiet
          after={terms || gold ? <>{terms}{gold}</> : undefined} />
        <div className={cn(k.wrap, styles.plans)}>
          <PlanCardsMNO cards={data.pricing.cards} yearlyBadge={data.pricing.yearlyBadge} showResult={data.showResult}
            membershipHref={membershipHref} risk={data.risk} recommendedFirst riskLine={riskLine} />
        </div>
        <FaqJ groups={data.faqGroups} />
        <FinalJ freeTrial={allOn(extras.flags, ['signupGrant'])} />
      </main>

      <SiteFooterJ />
    </MotionJ>
  );
}
