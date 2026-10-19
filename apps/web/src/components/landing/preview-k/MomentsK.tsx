/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useId, useState } from 'react';
import { FileText } from 'lucide-react';
import { PositioningClipJ } from '@/components/landing/preview-j/PositioningClipJ';
import { Glance } from '@/components/landing/preview-j/SamplesJ';
import page from '@/components/landing/preview-j/j.module.css';
import samples from '@/components/landing/preview-j/samples-j.module.css';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { J_PERSONA } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT } from '@/lib/landing/landing-copy-j-takeover';
import { K_MOMENTS_PICK, K_PLAN_CARD, type KeyMoment } from '@/lib/landing/landing-copy-k';
import styles from './k.module.css';

/** The note's lead-in: the plan's own words for what it shows (Owner 2026-10-17). */
const WHY = '为什么不是正确的废话';

/**
 * Region 3, "三个关键时刻" (Owner 2026-10-17, replacing the scroll-locked takeover): three tabs, one moment at a time,
 * picked by a click; nothing holds the scroll. Each moment: what happens, why it is not "正确的废话", and a still
 * picture of the real product — the workspace at that point of the sample conversation, or for the plan, the
 * 10-second card of this person's real report. Only the current tab's panel is shown; the words of all three are in the
 * server HTML.
 */
export function MomentsK({ moments }: { moments: readonly KeyMoment[] }) {
  const [active, setActive] = useState(0);
  const base = useId();
  if (moments.length === 0) return null;
  return (
    <section id="how-it-works" aria-labelledby="moments-title" className={styles.section} data-zone="takeover" data-region="三个关键时刻">
      <div className={styles.wrap}>
        <h2 id="moments-title" className={styles.lead}>
          {HOW_IT_WORKS.title.split(/(?=怎么)/).map(part => <span key={part} className={page.phrase}>{part}</span>)}
        </h2>
        <div role="tablist" aria-label={HOW_IT_WORKS.title} className={styles.steps}>
          {moments.map((moment, index) => (
            <button key={moment.id} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel-${index}`}
              aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)}
              onKeyDown={event => {
                const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!step) return;
                const next = (active + step + moments.length) % moments.length;
                setActive(next);
                document.getElementById(`${base}-tab-${next}`)?.focus();
              }}>
              <span aria-hidden="true">{index + 1}</span>{moment.label}
            </button>
          ))}
        </div>
        <p className={styles.pickHint}>{K_MOMENTS_PICK}</p>
        {moments.map((moment, index) => (
          <div key={moment.id} role="tabpanel" id={`${base}-panel-${index}`} aria-labelledby={`${base}-tab-${index}`}
            hidden={index !== active} className={styles.moment} data-region={moment.label}>
            <div className={styles.momentText}>
              <h3>{moment.label}</h3>
              <p>{moment.line}</p>
              <p className={styles.why}><b>{WHY}</b>{moment.note}</p>
            </div>
            <div className={styles.momentPicture}>
              {/* The workspace measures its chat to show the right message, so it is built only once its tab is shown. */}
              {!moment.window ? <PlanCard />
                : index === active ? <PositioningClipJ moment={moment.window.moment} local={0.5} pick={moment.window.pick} /> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The plan as the report's cover and its 10-second card (sample J's report window, for the page's own person). */
function PlanCard() {
  return (
    <div className={styles.planCard}>
      <header className={samples.cover}>
        <FileText size={22} aria-hidden="true" />
        <div>
          <p className={samples.coverLabel}>{J_REPORT.title}</p>
          <p className={styles.planTitle}>{J_PERSONA.account}</p>
          <p className={samples.size}>{J_REPORT.size}</p>
        </div>
      </header>
      <Glance data={K_PLAN_CARD} />
    </div>
  );
}
