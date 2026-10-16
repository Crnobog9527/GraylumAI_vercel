/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { CompareJ } from '@/components/landing/preview-j/CompareJ';
import type { PageExtras } from '@/components/landing/preview-j/extras-j';
import { PriceJ } from '@/components/landing/preview-j/PriceJ';
import type { LandingData } from '@/components/landing/preview-j/SampleJ';
import { FaqJ } from '@/components/landing/preview-j/SectionsJ';
import { SiteFooterJ } from '@/components/landing/preview-j/SiteFooterJ';
import { SiteHeaderJ } from '@/components/landing/preview-j/SiteHeaderJ';
import page from '@/components/landing/preview-j/j.module.css';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { StickyCtaMNO } from '@/components/landing/preview-mno/StickyCtaMNO';
import { K_GOLD_LINE, K_PRICE_TERMS } from '@/lib/landing/landing-copy-k';
import { L_CARE, L_COMPARE_NEXT, L_COMPARE_PICKS, L_COMPARE_TITLE, L_OPS } from '@/lib/landing/landing-copy-l';
import { allOn, visibleItems } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { HeroO } from './HeroO';
import { OpsO } from './OpsO';
import { RouteO } from './RouteO';
import { SamplesO } from './SamplesO';
import { CareO, FinalO, PlansO } from './SectionsO';
import { VoiceO } from './VoiceO';
import styles from './o.module.css';

const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'] as const;

/**
 * Style sample O, direction C "路线图" (Owner 2026-10-17; sample L stays as it was): sample L's content, in L's order,
 * on an off-white page with a faint dot grid in the content column and one route down its left rail, from station 0
 * at the first screen to 10 at the close. The voices are "你现在在这", each step of the week a station, the sample
 * reports "别人走到了这", the plans "从这里出发". All light: the comparison sits on the light band. The product windows
 * (the week's chat, the reports, the comparison's chats) are the real components, unchanged; only their frames and the
 * numbered notes around them are this sample's. Shared conversion rules: the thin "免费和教练聊聊" bar past the first
 * screen, a button at least every two regions, Gold most prominent with "先聊后买" right under the plans.
 */
export function SampleO({ data, siteName, extras, membershipHref }: {
  data: LandingData; siteName: string; extras: PageExtras; membershipHref: string;
}) {
  const faqIds = new Set(data.faqGroups.flatMap(group => group.items.map(item => item.id)));
  const terms = faqIds.has(K_PRICE_TERMS.faqId) ? (
    <p className={k.terms}>
      <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.cancel}</a> · <a href={`#${K_PRICE_TERMS.faqId}`}>{K_PRICE_TERMS.refund}</a>
    </p>
  ) : null;
  const gold = allOn(extras.flags, K_GOLD_LINE.needs) ? <p className={k.gold}>{K_GOLD_LINE.text}</p> : null;
  // The stations, numbered in page order: the first screen is 0, the close is always 10.
  const steps = visibleItems(extras.flags, L_OPS.steps);
  const stops = { voice: 1, ops: 2, samples: 2 + steps.length, care: 0, price: 0 };
  stops.care = stops.samples + (extras.showSamples ? 1 : 0);
  stops.price = stops.care + (visibleItems(extras.flags, L_CARE.items).length > 0 ? 1 : 0);
  return (
    <div className={cn(light.light, page.page, k.page, styles.page)}>
      <nav aria-label="样稿切换" className={page.sampleBar}>
        <span>不公开的风格样稿（O：路线图）</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'o' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <SiteHeaderJ siteName={siteName} />
      <StickyCtaMNO line={L_OPS.lede} />

      <main data-calm="">
        <RouteO>
          <HeroO note={data.heroNote} flags={extras.flags} />
          <VoiceO notes={data.notes} station={String(stops.voice)} />
          <OpsO steps={steps} flags={extras.flags} first={stops.ops} />
          {extras.showSamples ? <SamplesO station={String(stops.samples)} /> : null}
          <CareO flags={extras.flags} station={String(stops.care)} />
          <CompareJ title={L_COMPARE_TITLE} picks={L_COMPARE_PICKS} next={L_COMPARE_NEXT} band="tint" />
          <div className={styles.wrap}><CtaK /></div>
          <PriceJ proMonthly={data.pricing.proMonthly} rows={data.compareRows} calm plainTotal checked={false}
            after={terms || gold ? <>{terms}{gold}</> : undefined} />
          <PlansO data={data} membershipHref={membershipHref} station={String(stops.price)} />
          <FaqJ groups={data.faqGroups} />
          <FinalO freeTrial={allOn(extras.flags, ['signupGrant'])} />
        </RouteO>
      </main>

      <SiteFooterJ />
    </div>
  );
}
