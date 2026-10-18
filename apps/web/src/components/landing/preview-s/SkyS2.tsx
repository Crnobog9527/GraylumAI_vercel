/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './s2.module.css';

/** Fixed small stars of the footer's night sky (left %, top px, size px): still, never twinkling. */
const STARS: [number, number, number][] = [
  [6, 40, 2], [14, 92, 1.5], [23, 28, 2], [31, 120, 1.5], [44, 54, 2.5], [52, 18, 1.5], [61, 98, 2], [69, 36, 1.5],
  [77, 76, 2], [85, 22, 2.5], [92, 110, 1.5], [97, 58, 2],
];

/**
 * S2 "从清晨到深夜": one sky behind the whole page, its colour following the scroll without a seam — dawn peach on the
 * first screen, bright day blue through step one, dusk orange into lilac by the jury, night blue in the footer. The one
 * authored moment: on the first screen the sun rises a little as the sky brightens (once). Product windows stay white
 * and float on long soft shadows (s2.module.css).
 */
export function SkyS2() {
  return (
    <>
      <div className={styles.sky}><i className={styles.day} /><i className={styles.dusk} /></div>
      <div className={styles.scene}>
        <div className={styles.rise}><i className={styles.sun} /></div>
        <i className={styles.haze} />
        <i className={styles.dark} />
      </div>
      <div className={styles.stars}>
        {STARS.map(([left, top, size]) => <i key={`${left}-${top}`} style={{ left: `${left}%`, top, width: size, height: size }} />)}
      </div>
    </>
  );
}
