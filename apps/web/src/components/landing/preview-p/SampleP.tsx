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
import { HeroL } from '@/components/landing/preview-l/HeroL';
import lines from '@/components/landing/preview-l/l.module.css';
import { SamplesL } from '@/components/landing/preview-l/SamplesL';
import { ScenariosL } from '@/components/landing/preview-l/ScenariosL';
import { StepsL } from '@/components/landing/preview-l/StepsL';
import { StickyCtaMNO } from '@/components/landing/preview-mno/StickyCtaMNO';
import { HERO } from '@/lib/landing/landing-copy';
import { L_NOTE_ANSWERS, L_NOTE_HEADS, L_NOTE_REGIONS, L_OPS, L_PRICE_NOTE, L_VOICE_FOLD } from '@/lib/landing/landing-copy-l';
import { allOn } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import shell from './pqr.module.css';

export type Palette = 'p' | 'q' | 'r';
const PALETTES: readonly Palette[] = ['p', 'q', 'r'];
const NAMES: Record<Palette, string> = { p: '钴蓝', q: '深青绿', r: '紫罗兰' };

/**
 * Style samples P, Q and R (Owner 2026-10-18, the "装修轮"): sample L rebuilt in a new shell, its words, regions, demos
 * and interactions untouched (the very same components; sample L's own files are not changed). Only the shell moves: the
 * page and tray colours, one ink and its tints, the type scale, spacing rhythm, corners, shadows, buttons and tags,
 * header, closing panel, footer and first screen (pqr.module.css). The three pages differ only in their main colour and
 * tray colours (`palette`: P cobalt, Q deep teal, R violet).
 */
export function SampleP({ data, siteName, extras, palette }: { data: LandingData; siteName: string; extras: PageExtras; palette: Palette }) {
  const terms = <p className={k.terms}>{allOn(extras.flags, ['signupGrant']) ? L_PRICE_NOTE.free : L_PRICE_NOTE.noCard}</p>;
  return (
    <MotionJ className={cn(light.light, page.page, k.page, lines.lines, shell.shell)}>
      <div data-palette={palette} className={shell.palette}>
        <nav aria-label="样稿切换" className={page.sampleBar}>
          <span>不公开的风格样稿（{palette.toUpperCase()}：以 L 为底的装修，主色{NAMES[palette]}）</span>
          <Link href="/landing/preview/l">L</Link>
          {PALETTES.map(id => (
            <Link key={id} href={`/landing/preview/${id}`} aria-current={id === palette ? 'page' : undefined}>{id.toUpperCase()}</Link>
          ))}
        </nav>
        <SiteHeaderJ siteName={siteName} cta={HERO.primaryCta} />
        <StickyCtaMNO line={L_OPS.lede} phoneBottom hideHeaderCta />

        <main data-calm="">
          <HeroL note={data.heroNote} />
          <VoiceWallJ notes={data.notes} open regions={L_NOTE_REGIONS} compact={L_VOICE_FOLD} after={<CtaK />}
            heads={L_NOTE_HEADS} answers={L_NOTE_ANSWERS} />
          <StepsL flags={extras.flags} />
          {extras.showSamples ? <SamplesL /> : null}
          <ScenariosL flags={extras.flags} after={<CtaK />} />
          <PriceJ proMonthly={data.pricing.proMonthly} rows={data.compareRows} calm plainTotal checked={false} quiet
            after={terms} />
          <FaqJ groups={data.faqGroups} />
          <FinalJ freeTrial={allOn(extras.flags, ['signupGrant'])} />
        </main>

        <SiteFooterJ />
      </div>
    </MotionJ>
  );
}
