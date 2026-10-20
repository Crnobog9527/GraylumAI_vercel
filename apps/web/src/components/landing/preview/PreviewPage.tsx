/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowDown, ArrowRight } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { HERO, HOW_IT_WORKS, PRICE_COMPARE, RISK_REVERSAL } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { PreviewPriceCards } from './PreviewPriceCards';
import { PREVIEW_VARIANTS, type PreviewVariantId } from './variants';
import styles from './preview.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
type Data = ReturnType<typeof buildLandingPageData>;

/**
 * One style sample: first screen, the clickable demo (module 3) and the price section, with the final copy
 * unchanged. The samples share the light foundation and differ only in the treatments in preview.module.css.
 */
export function PreviewPage({ variant, data, siteName, membershipHref }: {
  variant: PreviewVariantId;
  data: Data;
  siteName: string;
  membershipHref: string;
}) {
  const { pricing } = data;
  const current = PREVIEW_VARIANTS.find(item => item.id === variant) ?? PREVIEW_VARIANTS[0];
  const promise = variant === 'c' ? <span className={styles.marker}>{HERO.promise}</span> : HERO.promise;
  return (
    <div className={cn(light.light, styles.page)} data-variant={variant}>
      <nav aria-label="样稿切换" className={styles.sampleBar}>
        <span>不公开的风格样稿，文案为定稿原文</span>
        {PREVIEW_VARIANTS.map(item => (
          <Link key={item.id} href={`/landing/preview/${item.id}`} aria-current={item.id === variant ? 'page' : undefined}>
            {item.name}
          </Link>
        ))}
        <p className={styles.sampleNote}>{current.summary} {current.review}</p>
      </nav>
      <header className={styles.header}>
        <div className={cn(styles.wrap, styles.headerInner)}>
          <Link href="/" className={styles.brand}>
            <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={28} height={28} />{siteName}
          </Link>
          <nav className={styles.nav} aria-label="主导航">
            {CHROME.nav.map(link => <Link key={link.href} href={link.href} className={styles.navOptional}>{link.label}</Link>)}
            <Link href={LOGIN_HREF}>{CHROME.login}</Link>
            <Link href={SIGNUP_CTA_HREF} className={cn(styles.primary, styles.navCta)}>{HERO.primaryCta}</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={cn(styles.wrap, styles.heroGrid)}>
            <div className={styles.heroText}>
              <h1 className={styles.title}>{HERO.title}</h1>
              <p className={styles.promise}>{promise}</p>
              <div className={styles.actions}>
                <Link href={SIGNUP_CTA_HREF} className={styles.primary}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
                <a href="#how-it-works" className={styles.secondary}>{HERO.secondaryCta}<ArrowDown size={18} aria-hidden="true" /></a>
              </div>
              <p className={styles.note}>{data.heroNote}</p>
            </div>
          </div>
        </section>

        <section id="how-it-works" aria-labelledby="how-title" className={cn(styles.section, styles.band)}>
          <div className={styles.wrap}>
            <h2 id="how-title" className={styles.h2}>{HOW_IT_WORKS.title}</h2>
            <p className={styles.lede}>{data.promise.map(part => part.text).join('')}</p>
            <LazyDemo />
          </div>
        </section>

        <section id="pricing" aria-labelledby="pricing-title" className={styles.section}>
          <div className={styles.wrap}>
            <h2 id="pricing-title" className={styles.h2}>{PRICE_COMPARE.title}</h2>
            {data.compareRows.length > 0 ? (
              <div className={styles.compare}>
                <p>{PRICE_COMPARE.lede}</p>
                <ul>
                  {data.compareRows.map((row, index) => (
                    <li key={row.sourceId}><span>{row.label}<sup>{index + 1}</sup></span><span>{row.price}</span></li>
                  ))}
                </ul>
                {pricing.proMonthly !== null ? <p className={styles.own}>{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p> : null}
              </div>
            ) : null}
            {pricing.cards.length > 0 ? (
              <PreviewPriceCards cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={data.showResult}
                membershipHref={membershipHref} />
            ) : <p role="status" className={styles.lede}>会员方案暂时读不到，请稍后刷新。</p>}
            <div className={styles.risk}>
              <p>{RISK_REVERSAL.title}</p>
              <ul>{data.risk.map(point => <li key={point.text}>{point.text}</li>)}</ul>
            </div>
            {data.compareRows.length > 0 ? (
              <div className={styles.sources}>
                <p>{PRICE_COMPARE.sourcesTitle}</p>
                <ol>{data.compareRows.map(row => <li key={row.sourceId}>{PRICE_COMPARE.sources[row.sourceId]}</li>)}</ol>
              </div>
            ) : null}
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.wrap}>© 2026 Grayscale Luminary LLC</div>
      </footer>
    </div>
  );
}
