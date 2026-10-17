/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { CompareJ } from '@/components/landing/preview-j/CompareJ';
import type { PageExtras } from '@/components/landing/preview-j/extras-j';
import type { LandingData } from '@/components/landing/preview-j/SampleJ';
import { FaqJ, FinalJ } from '@/components/landing/preview-j/SectionsJ';
import { SiteFooterJ } from '@/components/landing/preview-j/SiteFooterJ';
import { SiteHeaderJ } from '@/components/landing/preview-j/SiteHeaderJ';
import page from '@/components/landing/preview-j/j.module.css';
import k from '@/components/landing/preview-k/k.module.css';
import { StickyCtaMNO } from '@/components/landing/preview-mno/StickyCtaMNO';
import { J_NOTE_ANSWERS } from '@/lib/landing/landing-copy-j';
import { K_GOLD_LINE, K_PRICE_TERMS } from '@/lib/landing/landing-copy-k';
import { L_COMPARE_NEXT, L_COMPARE_PICKS, L_COMPARE_TITLE, L_NOTE_REGIONS, L_OPS, L_REPORTS, L_SAMPLES } from '@/lib/landing/landing-copy-l';
import { allOn, visibleItems } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { CareN } from './CareN';
import { HeroN, type HeroFacts } from './HeroN';
import { OpsN } from './OpsN';
import { PriceN } from './PriceN';
import { RootN } from './RootN';
import { SamplesN } from './SamplesN';
import { VoiceN } from './VoiceN';
import styles from './n.module.css';

const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'] as const;
/** The voice wall's own words the first screen may repeat (J_NOTE_ANSWERS.p1: "我们的 AI 教练 24 小时在线，……"). */
const ONLINE = { id: 'p1', who: 'AI 教练', what: '24 小时在线' } as const;

/** The first screen's two facts, each only while the page says it elsewhere. */
function heroFacts(data: LandingData, showSamples: boolean): HeroFacts {
  const answer = J_NOTE_ANSWERS[ONLINE.id] ?? '';
  const online = data.notes.some(note => note.id === ONLINE.id) && answer.includes(`${ONLINE.who} ${ONLINE.what}`)
    ? { who: ONLINE.who, what: ONLINE.what } : null;
  const count = L_REPORTS.length;
  const label = L_SAMPLES.title(count).split(String(count))[1]?.trim() ?? '';
  return { online, reports: showSamples && label ? { count, label } : null };
}

/**
 * Style sample N, direction E "便当格" (Owner 2026-10-17, aesthetic directions v3): sample L's content and order on a
 * warm neutral canvas of white cells, 14px apart, a few to a screen, a phone stacking them in one column with the big
 * ones first. One continuous element: a gold selection frame that moves to each region's key cell as you scroll
 * (RootN). All light: the comparison sits on the light band. Every product window is the real component, unchanged
 * (OpsChatL, CompareJ's windows, the sample report's dialog); a cell is at most its outer frame. Shared conversion
 * rules: the thin "免费和教练聊聊" bar once past the first screen, a button at least every two regions, Gold the most
 * prominent plan with "先聊后买" right under the cards. Region 3 shows the whole week at once instead of L's carousel.
 */
export function SampleN({ data, siteName, extras, membershipHref }: {
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
    <RootN className={cn(light.light, page.page, k.page, styles.root)}>
      <nav aria-label="样稿切换" className={page.sampleBar}>
        <span>不公开的风格样稿（N：便当格）</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'n' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <SiteHeaderJ siteName={siteName} />
      <StickyCtaMNO line={L_OPS.lede} />

      <main data-calm="" data-calm-windows="">
        <HeroN note={data.heroNote} flags={extras.flags} facts={heroFacts(data, Boolean(extras.showSamples))} />
        <VoiceN notes={data.notes} regions={L_NOTE_REGIONS} />
        <OpsN steps={visibleItems(extras.flags, L_OPS.steps)} flags={extras.flags} />
        {extras.showSamples ? <SamplesN /> : null}
        <CareN flags={extras.flags} />
        <CompareJ title={L_COMPARE_TITLE} picks={L_COMPARE_PICKS} next={L_COMPARE_NEXT} band="tint" />
        <PriceN pricing={data.pricing} rows={data.compareRows} risk={data.risk} showResult={data.showResult}
          membershipHref={membershipHref} after={terms || gold ? <>{terms}{gold}</> : null} />
        <FaqJ groups={data.faqGroups} />
        <FinalJ freeTrial={allOn(extras.flags, ['signupGrant'])} />
      </main>

      <SiteFooterJ />
    </RootN>
  );
}
