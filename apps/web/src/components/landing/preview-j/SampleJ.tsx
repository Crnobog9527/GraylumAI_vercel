/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import dynamic from 'next/dynamic';
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { allOn } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { HeroJ } from './HeroJ';
import { MotionJ } from './MotionJ';
import type { PageExtras } from './extras-j';
import { PriceJ } from './PriceJ';
import { CompareJ } from './CompareJ';
import { FaqJ, FinalJ } from './SectionsJ';
import { SamplesSectionJ } from './SamplesJ';
import { SiteFooterJ } from './SiteFooterJ';
import { SiteHeaderJ } from './SiteHeaderJ';
import { TakeoverJ } from './TakeoverJ';
import { VoiceWallJ } from './VoiceWallJ';
import { WorkJ } from './WorkJ';
import styles from './j.module.css';

/** The Owner's local edit mode: only in a development server; production builds drop the import entirely. */
const OwnerEditJ = process.env.NODE_ENV === 'development'
  ? dynamic(() => import('./OwnerEditJ').then(module => module.OwnerEditJ))
  : null;
const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
export type LandingData = ReturnType<typeof buildLandingPageData>;

/**
 * Style sample J (Owner 2026-10-14, after sample H's v3): sample E's design baseline carrying sample H's content.
 * Order (Owner 2026-10-16, by region number): the first screen, the voice wall (the pain), "AI 教练怎么接手你的运营"
 * as a scroll-locked story, the sample reports, "这些事，不用你再操心" (the work it takes off your hands), the
 * comparison (why a general AI does not solve it), price, the FAQ and the close. The server HTML is the finished page.
 */
export function SampleJ({ data, siteName, extras }: {
  data: LandingData; siteName: string; extras: PageExtras;
}) {
  return (
    <MotionJ className={cn(light.light, styles.page)}>
      <nav aria-label="样稿切换" className={styles.sampleBar}>
        <span>不公开的风格样稿</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'j' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <SiteHeaderJ siteName={siteName} />

      <main>
        <HeroJ note={data.heroNote} />
        <VoiceWallJ notes={data.notes} />
        <TakeoverJ />
        {extras.showSamples ? <SamplesSectionJ /> : null}
        <WorkJ flags={extras.flags} />
        <CompareJ />
        <PriceJ proMonthly={data.pricing.proMonthly} rows={data.compareRows} />
        <FaqJ groups={data.faqGroups} />
        <FinalJ freeTrial={allOn(extras.flags, ['signupGrant'])} />
      </main>

      <SiteFooterJ />
      {OwnerEditJ ? <OwnerEditJ /> : null}
    </MotionJ>
  );
}
