/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
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
import { StickyCtaMNO } from '@/components/landing/preview-mno/StickyCtaMNO';
import { HERO } from '@/lib/landing/landing-copy';
import { L_NOTE_ANSWERS, L_NOTE_HEADS, L_NOTE_REGIONS, L_OPS, L_PRICE_NOTE, L_VOICE_FOLD } from '@/lib/landing/landing-copy-l';
import { allOn } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { HeroL } from './HeroL';
import { JuryModuleL } from './JuryModuleL';
import { SamplesL } from './SamplesL';
import { ScenariosL } from './ScenariosL';
import { StepsL } from './StepsL';

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
 * Round three (Owner 2026-10-17; tagged sample-l-before-round3-2026-10-17): region 3 in two acts (the whole positioning
 * flow, then the week, with region 5's worries merged in and region 5 gone), the library and voice shown on their own,
 * the sample reports for finding someone like you, the comparison as the same task done by both, no plan cards.
 * Round four (Owner 2026-10-17, content and parts only; tagged sample-l-before-round4-2026-10-17): the first screen's
 * text alone, centred; region 3 as 第一步/第二步/第三步, step one sample J's whole flow on the real product's parts and
 * watched through, steps two and three only once built; the jury larger, after step one; region 6 one scenario at a
 * time. Every capability not built yet is off (landing-flags), so its block does not show.
 */
export function SampleL({ data, siteName, extras }: { data: LandingData; siteName: string; extras: PageExtras }) {
  // Under the price button (Owner 2026-10-17, round six): "无需绑卡 · 免费试用"; cancelling and refunds are explained on
  // the price page, not here, and the home page carries no "先聊后买" or Gold line.
  const terms = <p className={k.terms}>{allOn(extras.flags, ['signupGrant']) ? L_PRICE_NOTE.free : L_PRICE_NOTE.noCard}</p>;
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
        <HeroL note={data.heroNote} />
        <VoiceWallJ notes={data.notes} open regions={L_NOTE_REGIONS} compact={L_VOICE_FOLD} after={<CtaK />}
          heads={L_NOTE_HEADS} answers={L_NOTE_ANSWERS} />
        <StepsL flags={extras.flags} />
        <JuryModuleL flags={extras.flags} />
        {extras.showSamples ? <SamplesL /> : null}
        <ScenariosL flags={extras.flags} after={<CtaK />} />
        <PriceJ proMonthly={data.pricing.proMonthly} rows={data.compareRows} calm plainTotal checked={false} quiet
          after={terms} />
        <FaqJ groups={data.faqGroups} />
        <FinalJ freeTrial={allOn(extras.flags, ['signupGrant'])} />
      </main>

      <SiteFooterJ />
    </MotionJ>
  );
}
