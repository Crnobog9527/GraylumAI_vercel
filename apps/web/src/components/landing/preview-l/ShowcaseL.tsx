/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type ReactNode } from 'react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import k from '@/components/landing/preview-k/k.module.css';
import type { LandingFlags } from '@/lib/landing/landing-flags';
import {
  L_SHOWCASE, L_SHOWCASE_LIBRARY, L_SHOWCASE_VOICE, type ShowcaseBeat,
} from '@/lib/landing/landing-copy-l-showcase';
import { LibraryPictureL, VoicePictureL } from './ShowcasePicturesL';
import styles from './l.module.css';
import showcase from './showcase-l.module.css';

/**
 * Under region 3 (Owner 2026-10-17): the library and writing in your own voice, the two things people care most
 * about, each told on its own. Each part: a heading, one plain line, three short steps you can click, and the product
 * window for the chosen step. All the steps' words stay on the page; the window is a picture (inert, aria-hidden).
 * Nothing plays by itself; with reduced motion the window's messages are simply there. A part whose capability is off
 * is left out; with both off there is no block.
 */
export function ShowcaseL({ flags }: { flags: LandingFlags }) {
  if (!flags.library && !flags.voice) return null;
  return (
    <section aria-labelledby="showcase-title" className={k.section} data-zone="work" data-region="资料库和文风">
      <div className={k.wrap}>
        <h2 id="showcase-title" className={k.minor}>{L_SHOWCASE.title}</h2>
        <p className={k.minorLede}>{L_SHOWCASE.lede}</p>
        {flags.library ? (
          <PartL id="showcase-library" region="资料库" copy={L_SHOWCASE_LIBRARY}
            picture={beat => <LibraryPictureL beat={beat} />} />
        ) : null}
        {flags.voice ? (
          <PartL id="showcase-voice" region="文风参考" copy={L_SHOWCASE_VOICE}
            picture={beat => <VoicePictureL beat={beat} />} />
        ) : null}
      </div>
    </section>
  );
}

function PartL({ id, region, copy, picture }: {
  id: string; region: string;
  copy: { name: string; title: string; line: string; beats: readonly ShowcaseBeat[] };
  picture: (beat: number) => ReactNode;
}) {
  const [beat, setBeat] = useState(0);
  return (
    <div className={showcase.part} data-region={region} aria-labelledby={`${id}-title`} role="group">
      <div className={showcase.text}>
        <p className={showcase.kicker}>{copy.name}</p>
        <h3 id={`${id}-title`} className={showcase.title}>{copy.title}</h3>
        <p className={showcase.line}>{copy.line}</p>
        <ol className={showcase.beats}>
          {copy.beats.map((item, index) => (
            <li key={item.label}>
              <button type="button" aria-pressed={index === beat} onClick={() => setBeat(index)}>
                <span className={showcase.number} aria-hidden="true">{index + 1}</span>
                <span><b>{item.label}</b><span>{item.line}</span></span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className={showcase.picture}>
        <p className={showcase.pictureLine}><span className={styles.demoTag}>{DEMO_LABEL}</span>{copy.beats[beat].label}</p>
        {/* A new step mounts a new window, so its messages arrive again. */}
        <div key={beat} className={showcase.stage}>{picture(beat)}</div>
      </div>
    </div>
  );
}
