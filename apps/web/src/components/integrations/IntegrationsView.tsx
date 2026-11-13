/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { ChevronRight, Image as ImageIcon } from 'lucide-react';
import { connectMessage, INTEGRATIONS, type IntegrationModule } from '@/lib/integrations/catalog';
import { IntegrationDetail } from './IntegrationDetail';
import { useShotviva, type ShotvivaState } from './use-shotviva';
import styles from './integrations.module.css';

/** The integrations page (INTEGRATION-SHOTVIVA PR C): one module per product built around Graylum, its connection state,
 * and its full introduction on a click. `result`: what Shotviva's redirect back said (?shotviva / ?shotviva_error). */
export function IntegrationsView({ result }: { result: { connected?: string | null; error?: string | null } }) {
  const shotviva = useShotviva();
  const [openId, setOpenId] = useState<string | null>(null);
  const banner = connectMessage(result);
  return (
    <main className={styles.page}>
      <h1>集成</h1>
      <p className={styles.lede}>和 Graylum 一起用的产品。点开看看它能做什么、什么时候适合用。</p>
      {banner && <p role={banner.tone === 'error' ? 'alert' : 'status'} className={banner.tone === 'error' ? styles.bannerError : styles.banner}>
        {banner.text}</p>}
      <ul className={styles.cards}>
        {INTEGRATIONS.map(module => (
          <li key={module.id}>
            <button type="button" className={styles.card} onClick={() => setOpenId(module.id)} aria-haspopup="dialog">
              <i aria-hidden="true"><ImageIcon /></i>
              <span className={styles.cardText}><b>{module.name}</b><span>{module.tagline}</span></span>
              <StatusChip module={module} shotviva={shotviva}/>
              <ChevronRight size={18} aria-hidden="true" className={styles.chevron}/>
            </button>
            <IntegrationDetail module={module} open={openId === module.id} onOpenChange={open => setOpenId(open ? module.id : null)}
              {...(module.connector === 'shotviva' ? { shotviva } : {})}/>
          </li>
        ))}
      </ul>
    </main>
  );
}

function StatusChip({ module, shotviva }: { module: IntegrationModule; shotviva: ShotvivaState }) {
  if (module.connector !== 'shotviva') return null;
  const data = shotviva.status.data;
  const text = shotviva.status.isLoading ? '读取中' : data?.connected ? '已连接' : '未连接';
  return <small className={styles.chip} data-connected={data?.connected ? 'true' : 'false'}>{text}</small>;
}
