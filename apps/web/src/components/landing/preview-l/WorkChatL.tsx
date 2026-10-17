/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import work from '@/app/runtime/runtime-work.module.css';
import result from '@/components/opc/positioning-result.module.css';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import type { OpsLine } from '@/lib/landing/landing-copy-l';
import { OpsCardL } from './OpsCardL';
import styles from './l.module.css';

/** The work chat's head as the product shows it for a work item: platform · account (runtime/page.tsx). */
const ACCOUNT = 'TikTok · 下班后 15 分钟家常菜';
/** The work chat's own name for a conversation without a single work item (runtime/page.tsx). */
const TITLE = '工作对话';

/**
 * One step of region 3's week in the product's own work chat (Owner 2026-10-17: a demo must look like the real
 * product): the runtime page's head, transcript, user bubble and coach message with its own head, "Graylum · AI
 * 自媒体陪跑教练", all from runtime-work.module.css; the coach's text in the product's message body style. Nothing of the
 * landing page's styles reaches inside. The cards are the example's content (topics, script, the test, the result, the
 * series). The window is a picture (inert); the step's line above it carries the meaning.
 */
export function WorkChatL({ step, flags }: { step: { lines: readonly OpsLine[] }; flags: LandingFlags }) {
  const lines = step.lines.filter(line => allOn(flags, line.needs) && !(line.without && flags[line.without]));
  return (
    <div className={styles.workWindow} inert aria-hidden="true">
      <header className={work.workHead}>
        <div className={work.workTitle}><p className={styles.workTitleText}>{TITLE}</p></div>
        <div className={work.workMeta}><span>{ACCOUNT}</span></div>
      </header>
      <section className={work.transcript}>
        {lines.map((line, index) => (
          <div key={line.text} className={styles.workTurn} style={{ '--m': index } as CSSProperties}>
            {line.role === 'user' ? <p className={work.userMessage}>{line.text}</p> : (
              <div className={work.agentMessage}>
                <div className={work.agentIdentity}><img src="/graylum-logo.png" alt="" /><span>Graylum · AI 自媒体陪跑教练</span></div>
                <p className={result.messageBody}>{line.text}</p>
                {line.card ? <OpsCardL card={line.card} /> : null}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
