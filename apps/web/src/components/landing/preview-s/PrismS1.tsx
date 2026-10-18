/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './s1.module.css';

/** The six colours a prism splits white light into, red at the top. */
const SPECTRUM = ['#ff8a7a', '#ffc078', '#ffe08a', '#8ce99a', '#74c0fc', '#b197fc'];
/** Where the light leaves the prism (narrow) and where the fan meets the right edge (wide), in the scene's units. */
const EXIT = { x: 342, top: 474, bottom: 492 };
const EDGE = { x: 1500, top: 300, bottom: 800 };

function band(index: number) {
  const at = (from: number, to: number, part: number) => from + ((to - from) * part) / SPECTRUM.length;
  return [
    `${EXIT.x},${at(EXIT.top, EXIT.bottom, index)}`, `${EDGE.x},${at(EDGE.top, EDGE.bottom, index)}`,
    `${EDGE.x},${at(EDGE.top, EDGE.bottom, index + 1)}`, `${EXIT.x},${at(EXIT.top, EXIT.bottom, index + 1)}`,
  ].join(' ');
}

/**
 * S1 "一束光穿过棱镜": on the first screen a beam of white light comes in from the top left, goes through a clear prism
 * and opens into a soft spectrum behind the title (drawn once, then breathing slowly). Further down, only light at the
 * screen's edges: blue beside step one, violet beside the jury (`--w1`, `--w2`); the footer is the spectrum gathered
 * back into one deep colour (s1.module.css).
 */
export function PrismS1() {
  return (
    <>
      <svg className={styles.scene} viewBox="0 0 1440 940" preserveAspectRatio="xMidYMid slice">
        <defs>
          <filter id="s1-soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="16" /></filter>
          <filter id="s1-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6" /></filter>
          <linearGradient id="s1-beam" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff6d8" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff1c4" />
            <stop offset="1" stopColor="#ffffff" />
          </linearGradient>
          <linearGradient id="s1-glass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity=".95" />
            <stop offset="1" stopColor="#dfe4ff" stopOpacity=".75" />
          </linearGradient>
          <linearGradient id="s1-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity=".35" />
            <stop offset=".45" stopColor="#fff" stopOpacity=".55" />
            <stop offset="1" stopColor="#fff" stopOpacity="1" />
          </linearGradient>
          <mask id="s1-mask"><rect width="1500" height="940" fill="url(#s1-fade)" /></mask>
        </defs>
        <g className={styles.spectrum} mask="url(#s1-mask)">
          <g className={styles.breath} filter="url(#s1-soft)">
            {SPECTRUM.map((colour, index) => <polygon key={colour} points={band(index)} fill={colour} />)}
          </g>
        </g>
        <g className={styles.beam}>
          <line x1="-30" y1="110" x2="262" y2="478" stroke="#f2c46b" strokeOpacity=".55" strokeWidth="14" filter="url(#s1-glow)"
            pathLength={1} />
          <line x1="-30" y1="110" x2="262" y2="478" stroke="url(#s1-beam)" strokeWidth="5" strokeLinecap="round" pathLength={1} />
        </g>
        <g className={styles.prism}>
          <polygon points="300,398 214,562 386,562" fill="url(#s1-glass)" stroke="#b9c0ec" strokeWidth="1.5" strokeLinejoin="round" />
          <polyline points="300,398 300,562" stroke="#ffffff" strokeOpacity=".9" strokeWidth="1.5" />
          <line x1="262" y1="478" x2="342" y2="483" stroke="#fff3cf" strokeWidth="4" strokeLinecap="round" />
        </g>
      </svg>
      <div className={styles.edges}><i className={styles.blue} /><i className={styles.violet} /></div>
    </>
  );
}
