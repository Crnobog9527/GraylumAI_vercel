/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { MotionJ } from '@/components/landing/preview-j/MotionJ';
import { SiteFooterJ } from '@/components/landing/preview-j/SiteFooterJ';
import { SiteHeaderJ } from '@/components/landing/preview-j/SiteHeaderJ';
import k from '@/components/landing/preview-k/k.module.css';
import { HeroL } from '@/components/landing/preview-l/HeroL';
import lines from '@/components/landing/preview-l/l.module.css';
import { StepsL } from '@/components/landing/preview-l/StepsL';
import { HERO } from '@/lib/landing/landing-copy';
import type { LandingFlags } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { ArtS, type Variant } from './ArtS';
import base from './s-base.module.css';
import s1 from './s1.module.css';
import s2 from './s2.module.css';
import s3 from './s3.module.css';
import s4 from './s4.module.css';
import s5 from './s5.module.css';

const VARIANTS: readonly Variant[] = ['s1', 's2', 's3', 's4', 's5'];
const SHELLS: Record<Variant, string> = { s1: s1.shell!, s2: s2.shell!, s3: s3.shell!, s4: s4.shell!, s5: s5.shell! };
const NAMES: Record<Variant, string> = { s1: '一束光穿过棱镜', s2: '从清晨到深夜', s3: '创作者的剪贴本', s4: '生活切片拼成的电影海报', s5: '众生百态首屏 + 视差场景卡片' };

/**
 * Art direction samples S1–S4 (Owner 2026-10-18, after P/Q/R were turned down): three parts of sample L — the first
 * screen, step one through the jury, the footer — each on a backdrop of its own (ArtS). The parts are sample L's own
 * components, untouched (L's files do not change); steps two and three are left out (s-base.module.css). Computer
 * widths only (1440, 1280) this round.
 */
export function SampleS({ variant, siteName, flags, heroNote }: { variant: Variant; siteName: string; flags: LandingFlags; heroNote: string }) {
  return (
    <MotionJ className={cn(light.light, page.page, k.page, lines.lines, base.shell, SHELLS[variant])}>
      <nav aria-label="样稿切换" className={page.sampleBar}>
        <span>不公开的艺术方向小样（{variant.toUpperCase()}：{NAMES[variant]}，只做电脑端）</span>
        <Link href="/landing/preview/l">L</Link>
        {VARIANTS.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === variant ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <ArtS variant={variant} />
      <SiteHeaderJ siteName={siteName} cta={HERO.primaryCta} />
      <main data-calm="">
        <HeroL note={heroNote} />
        <StepsL flags={flags} />
      </main>
      <SiteFooterJ />
    </MotionJ>
  );
}
