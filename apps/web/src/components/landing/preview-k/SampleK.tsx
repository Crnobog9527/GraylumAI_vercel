/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { HeroJ } from '@/components/landing/preview-j/HeroJ';
import { MotionJ } from '@/components/landing/preview-j/MotionJ';
import type { PageExtras } from '@/components/landing/preview-j/extras-j';
import { PriceJ } from '@/components/landing/preview-j/PriceJ';
import type { LandingData } from '@/components/landing/preview-j/SampleJ';
import { FaqJ, FinalJ } from '@/components/landing/preview-j/SectionsJ';
import { SiteFooterJ } from '@/components/landing/preview-j/SiteFooterJ';
import { SiteHeaderJ } from '@/components/landing/preview-j/SiteHeaderJ';
import { VoiceWallJ } from '@/components/landing/preview-j/VoiceWallJ';
import page from '@/components/landing/preview-j/j.module.css';
import { allOn, visibleItems } from '@/lib/landing/landing-flags';
import { K_GOLD_LINE, K_MOMENTS, K_PRICE_TERMS } from '@/lib/landing/landing-copy-k';
import { cn } from '@/lib/utils';
import { CompareK } from './CompareK';
import { MomentsK } from './MomentsK';
import { RhythmK } from './RhythmK';
import { SamplesK } from './SamplesK';
import styles from './k.module.css';

const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] as const;
/** The first screen's still picture: the week's 选题 stage (the coach proposes, the person pushes back, it adapts). */
const HERO_STILL = 1;

/**
 * Style sample K: sample J slimmed down (Owner 2026-10-16/17, all 19 points of the distill plan at once; sample J stays
 * as it was, for comparing and rolling back). The first screen holds still; the voice wall shows four; "三个关键时刻"
 * replaces the scroll-locked takeover; the sample reports show only their 10-second cards; the work becomes one row of
 * the week; two comparisons, in plain type; buttons after the reports and the comparison; price as it was, with the
 * terms and the jury's one line under its button. Only regions 3 and 4 use product windows.
 */
export function SampleK({ data, siteName, extras }: { data: LandingData; siteName: string; extras: PageExtras }) {
  const faqIds = new Set(data.faqGroups.flatMap(group => group.items.map(item => item.id)));
  const terms = faqIds.has(K_PRICE_TERMS.faqId) ? (
    <p className={styles.terms}>
      <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.cancel}</a> · <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.refund}</a>
    </p>
  ) : null;
  const gold = allOn(extras.flags, K_GOLD_LINE.needs) ? <p className={styles.gold}>{K_GOLD_LINE.text}</p> : null;
  return (
    <MotionJ className={cn(light.light, page.page, styles.page)}>
      <nav aria-label="样稿切换" className={page.sampleBar}>
        <span>不公开的风格样稿（K：J 的精简版）</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'k' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <SiteHeaderJ siteName={siteName} />

      <main data-calm="" data-calm-windows="">
        <HeroJ note={data.heroNote} still={HERO_STILL} />
        <VoiceWallJ notes={data.notes} four />
        <MomentsK moments={visibleItems(extras.flags, K_MOMENTS)} />
        {extras.showSamples ? <SamplesK /> : null}
        <RhythmK flags={extras.flags} />
        <CompareK />
        <PriceJ proMonthly={data.pricing.proMonthly} rows={data.compareRows} calm after={terms || gold ? <>{terms}{gold}</> : undefined} />
        <FaqJ groups={data.faqGroups} />
        <FinalJ freeTrial={allOn(extras.flags, ['signupGrant'])} />
      </main>

      <SiteFooterJ />
    </MotionJ>
  );
}
