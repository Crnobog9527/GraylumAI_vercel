/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import light from '@/components/design/light-tokens.module.css';
import { closeConsentPreferences, denyConsent, grantConsent, type ConsentSnapshot } from '@/lib/analytics/consent';
import type { SiteLocale } from '@/lib/seo/site';
import { cn } from '@/lib/utils';
import styles from './consent-bar.module.css';

export const CONSENT_BAR_LABEL = 'Cookie 同意';

const COPY = {
  'zh-Hans': {
    body: '我们用统计工具了解大家怎么使用 Graylum，用来改进产品。点“接受”开启统计；点“仅必要”只保留网站运行必需的功能。',
    policy: 'Cookie 政策',
    granted: '当前：已开启统计。',
    denied: '当前：仅必要。',
    gpc: '你的浏览器开启了“全局隐私控制”（GPC），我们不会开启统计。',
    accept: '接受',
    necessary: '仅必要',
    close: '关闭',
  },
  'zh-TW': {
    body: '我們用統計工具了解大家如何使用 Graylum，用來改進產品。點「接受」開啟統計；點「僅必要」只保留網站運作必需的功能。',
    policy: 'Cookie 政策',
    granted: '目前：已開啟統計。',
    denied: '目前：僅必要。',
    gpc: '你的瀏覽器開啟了「全球隱私控制」（GPC），我們不會開啟統計。',
    accept: '接受',
    necessary: '僅必要',
    close: '關閉',
  },
} as const;

/**
 * The statistics consent bar (ANALYTICS-CONSENT, Owner 2026-11-07). Shows by itself only to an opt-in-region visitor who
 * has not chosen yet; "Cookie 设置" (footer, profile) reopens it in every region with the current state and a close
 * button. Fixed over the page bottom: it never moves the page's own layout. Not a modal: the page stays usable. The two
 * choices look the same, so refusing is as easy as accepting.
 */
export function ConsentBar({ consent, locale }: { consent: ConsentSnapshot; locale: SiteLocale }) {
  const first = useRef<HTMLButtonElement>(null);
  const { ready, promptOpen, reopened, gpc, analytics } = consent;
  // Opened from "Cookie 设置": move focus into the bar so keyboard users land on the choice.
  useEffect(() => {
    if (ready && promptOpen && reopened) first.current?.focus();
  }, [ready, promptOpen, reopened]);
  if (!ready || !promptOpen) return null;
  const copy = COPY[locale];
  const status = gpc ? copy.gpc : reopened ? (analytics ? copy.granted : copy.denied) : null;
  return (
    <section role="region" aria-label={CONSENT_BAR_LABEL} className={cn(light.light, styles.bar)}
      style={{ background: 'var(--gl-surface)' }}>
      <p className={styles.text}>
        {copy.body} <a className={styles.link} href="/cookies">{copy.policy}</a>
        {status ? <span className={styles.status}>{status}</span> : null}
      </p>
      <div className={styles.actions}>
        {gpc ? null : (
          <>
            <Button ref={first} type="button" variant="outline" className={styles.button} onClick={denyConsent}>
              {copy.necessary}
            </Button>
            <Button type="button" variant="outline" className={styles.button} onClick={grantConsent}>
              {copy.accept}
            </Button>
          </>
        )}
        {reopened ? (
          <button ref={gpc ? first : undefined} type="button" className={styles.close} aria-label={copy.close}
            onClick={closeConsentPreferences}>
            <X aria-hidden size={16} />
          </button>
        ) : null}
      </div>
    </section>
  );
}
