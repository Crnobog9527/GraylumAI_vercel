/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { connectMessage, INTEGRATIONS, type IntegrationModule } from '@/lib/integrations/catalog';
import { IntegrationDetail, IntegrationIcon } from './IntegrationDetail';
import { useShotviva, type ShotvivaState } from './use-shotviva';
import { useConnection, type ConnectionState } from './use-connection';
import styles from './integrations.module.css';

/** The integrations page (INTEGRATION-SHOTVIVA PR C): one module per product built around Graylum, its connection state,
 * and its full introduction on a click. `result`: what Shotviva's redirect back said (?shotviva / ?shotviva_error). */
export function IntegrationsView({ result }: { result: { connected?: string | null; error?: string | null } }) {
  const shotviva = useShotviva();
  const feishu = useConnection('feishu_base');
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
              <IntegrationIcon module={module}/>
              <span className={styles.cardText}><b>{module.name}</b><span>{module.tagline}</span></span>
              <StatusChip module={module} shotviva={shotviva} feishu={feishu}/>
              <ChevronRight size={18} aria-hidden="true" className={styles.chevron}/>
            </button>
            <IntegrationDetail module={module} open={openId === module.id} onOpenChange={open => setOpenId(open ? module.id : null)}
              {...(module.connector === 'shotviva' ? { shotviva } : {})} {...(module.connector === 'feishu_base' ? { connection: feishu } : {})}/>
          </li>
        ))}
      </ul>
    </main>
  );
}

function StatusChip({ module, shotviva, feishu }: { module: IntegrationModule; shotviva: ShotvivaState; feishu: ConnectionState }) {
  const status = module.connector === 'shotviva' ? shotviva.status : module.connector === 'feishu_base' ? feishu.status : null;
  if (!status) return null;
  const data = status.data;
  const failed = !!data && 'failed' in data && data.failed;
  // An unreadable state is said as such (the detail says the same), never "未连接".
  const text = status.isLoading ? '读取中' : !data ? '状态读取失败' : failed ? '需重新连接' : data.connected ? '已连接' : '未连接';
  return <small className={styles.chip} data-connected={data?.connected && !failed ? 'true' : 'false'}>{text}</small>;
}
