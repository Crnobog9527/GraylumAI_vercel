/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './s4.module.css';

/**
 * The four stills, one per part of the page (the Owner's AI-generated pictures, local preview only, marked 示意):
 * late-night kitchen, the desk with the phone stand, a corner of a rented room, a small shop on the street at night.
 */
const STILLS = ['/landing-s/s-1.webp', '/landing-s/s-2.webp', '/landing-s/s-3.webp', '/landing-s/s-4.webp'];

/**
 * S4 "生活切片拼成的电影海报": the page is a film poster made of everyday life — large stills in one warm orange and
 * teal grade behind the content, crossing into each other as the reader moves on (each fades in with its part's weight,
 * `--w0`…`--w3`, settling from a slight zoom). The one authored moment: the first still pushes in slowly (Ken Burns,
 * once). A dark veil keeps every word legible; product windows stay white and sharp (s4.module.css).
 */
export function PosterS4() {
  return (
    <div className={styles.stills}>
      {STILLS.map((still, part) => (
        <i key={still} className={styles.still} data-part={part}><span style={{ backgroundImage: `url(${still})` }} /></i>
      ))}
      <i className={styles.veil} />
      <i className={styles.grain} />
      <span className={styles.mark}>照片为 AI 生成示意</span>
    </div>
  );
}
