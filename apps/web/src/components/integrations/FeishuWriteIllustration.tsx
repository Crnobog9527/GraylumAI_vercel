/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './feishu-illustration.module.css';

/**
 * What the Feishu Base connector does, drawn (Owner 2026-11-14: "画示意动效，不用截图"): a work in Graylum moves into the user's
 * table and becomes one row, its cells filling in. It plays twice when the dialog opens (the dialog's content is mounted only
 * while it is open) and rests on the finished row; with reduced motion it only shows that finished row. Made-up content, no
 * screenshot of Feishu.
 */
export function FeishuWriteIllustration() {
  return (
    <figure className={styles.stage} role="img" aria-label="示意：Graylum 里写好的一篇作品，写进飞书多维表格，成为表格里的一行">
      <div className={styles.work} aria-hidden="true">
        <small>Graylum 作品</small>
        <b>咖啡店的三种拍法</b>
        <i/><i/>
      </div>
      <div className={styles.table} aria-hidden="true">
        <div className={styles.head}><span>标题</span><span>平台</span><span>状态</span></div>
        <div className={styles.old}><span><i/></span><span><i/></span><span><i/></span></div>
        <div className={styles.fresh}><span>咖啡店的三种拍法</span><span>小红书</span><span>待发布</span></div>
      </div>
    </figure>
  );
}
