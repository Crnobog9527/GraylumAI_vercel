/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowRight, MoveRight } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { RevealOnScroll } from '@/components/landing/offer/RevealOnScroll';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { FINAL_ACTION, HERO, VOICE_WALL } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { FHowItWorks } from './FHowItWorks';
import { FFaq, FPrice } from './FPriceFaq';
import styles from './sample-f.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
const TILTS = ['-1.4deg', '1deg', '-.6deg', '1.3deg'];
type Data = ReturnType<typeof buildLandingPageData>;

/** The dark film-still stage used for the first and last screen. */
function Stage({ children }: { children: ReactNode }) {
  return (
    <div className={styles.stage}>
      <div aria-hidden="true" className={styles.glow} />
      <div aria-hidden="true" className={styles.grain} />
      {children}
    </div>
  );
}

/**
 * Style sample F (PUBLIC-SITE, not public): the landing page's six sections in their fixed order and final copy
 * (hero, sticky notes, how the coach works, price, FAQ, final action), in a public-page layer that borrows
 * ploy.ai's visual language. The demo is the #893 component; everything else reads the landing page's data.
 */
export function SampleF({ data, siteName, membershipHref }: { data: Data; siteName: string; membershipHref: string }) {
  const sources = data.notes.map(note => note.source);
  return (
    <div className={cn(light.light, styles.page)}>
      <p className={styles.sampleBar}><b>不公开的风格样稿 F</b><span>Design 插件 · 参考 ploy.ai 的视觉语言，文案和板块顺序为定稿原文</span></p>
      <header className={styles.header}>
        <div className={cn(styles.wrap, styles.headerInner)}>
          <Link href="/landing" className={styles.brand} aria-label={siteName}>
            <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={28} height={28} /><span>{siteName}</span>
          </Link>
          <nav className={styles.nav} aria-label="主导航">
            <span className={styles.navLinks}>{CHROME.nav.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}</span>
            <Link href={LOGIN_HREF} className={styles.login}>{CHROME.login}</Link>
            <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillSmall)}>{HERO.primaryCta}</Link>
          </nav>
        </div>
      </header>

      <main>
        <Stage>
          <section className={styles.hero} aria-labelledby="f-hero-title">
            <h1 id="f-hero-title" className={styles.display}>{HERO.title}</h1>
            <p className={styles.heroPromise}>{HERO.promise}</p>
            <div className={styles.actions}>
              <Link href={SIGNUP_CTA_HREF} className={styles.pillLight}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
              <a href="#how-it-works" className={styles.pillGhost}>{HERO.secondaryCta}<ArrowDown size={18} aria-hidden="true" /></a>
            </div>
            <p className={styles.heroNote}>{data.heroNote}</p>
          </section>
        </Stage>

        {data.notes.length > 0 ? (
          <section aria-labelledby="f-voice-title" className={cn(styles.section, styles.deferred)}>
            <div className={styles.wrap}>
              <div className={styles.split}>
                <h2 id="f-voice-title" className={styles.h2}>{VOICE_WALL.title}</h2>
                <p className={styles.lede}>{VOICE_WALL.lede}</p>
              </div>
              <RevealOnScroll className={styles.voiceRows}>
                {data.notes.map((note, index) => (
                  <div key={note.id} data-reveal-row="" className={styles.voiceRow}>
                    <figure className={styles.note} style={{ '--tilt': TILTS[index % TILTS.length] } as CSSProperties}>
                      <blockquote>「{note.quote}」</blockquote>
                      <figcaption>{note.source}{note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}</figcaption>
                    </figure>
                    <MoveRight className={styles.arrow} size={28} aria-hidden="true" />
                    <div className={cn(styles.card, styles.later)}>
                      <p className={styles.answerHead}><i aria-hidden="true" />教练怎么做</p>
                      <p className={styles.answer}>{note.answer}</p>
                    </div>
                  </div>
                ))}
              </RevealOnScroll>
            </div>
            <div aria-hidden="true" className={styles.marquee}>
              <div className={styles.marqueeTrack}>{[...sources, ...sources].map((source, index) => <span key={index}>{source}</span>)}</div>
            </div>
          </section>
        ) : null}

        <FHowItWorks promise={data.promise} steps={data.flowSteps} timeline={data.timeline} reports={data.sampleReports} />
        <FPrice data={data} membershipHref={membershipHref} />
        <FFaq groups={data.faqGroups} />

        <Stage>
          <section aria-labelledby="f-final-title" className={styles.final}>
            <h2 id="f-final-title" className={styles.h2}>{FINAL_ACTION.title}</h2>
            <ul className={styles.paths}>{FINAL_ACTION.paths.map(path => <li key={path} className={styles.path}>{path}</li>)}</ul>
            {data.showStack ? <p className={styles.stack}><b>{FINAL_ACTION.stackLabel}</b>{FINAL_ACTION.stack.text}</p> : null}
            {data.founderSeats !== null ? (
              <p className={styles.founderDark}>{FINAL_ACTION.founderLine}<span>还剩 {data.founderSeats} 个名额</span></p>
            ) : null}
            <Link href={SIGNUP_CTA_HREF} className={styles.pillLight}>{FINAL_ACTION.cta}<ArrowRight size={18} aria-hidden="true" /></Link>
            <p className={styles.heroNote}>{data.finalNote}</p>
          </section>
        </Stage>
      </main>

      <footer className={styles.footer}>
        <div className={styles.wrap}>© 2026 Grayscale Luminary LLC</div>
      </footer>
    </div>
  );
}
