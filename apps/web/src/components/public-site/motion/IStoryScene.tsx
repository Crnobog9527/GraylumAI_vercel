/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './i-story-backdrop.module.css';

/*
 * The panorama of IStoryBackdrop, drawn as line art (one ink stroke, flat pastel fills). Six chapters from left to
 * right, one per part of the page: 1 a blank account and a worried person, 2 the coach arrives and they talk,
 * 3 looking at accounts to learn from, 4 the report, 5 filming, 6 the account running (posts filled in, hearts and
 * comments rising). The same person (mint shirt) and the same coach (a coral speech bubble with eyes) appear in
 * every chapter. Idle motion classes come from the backdrop's stylesheet; every moving group sits inside a group
 * that only positions it, because a CSS transform would replace an SVG transform attribute.
 */

type Pose = 'rest' | 'phone' | 'point' | 'talk' | 'cheer';

const ARMS: Record<Pose, string> = {
  rest: 'M-24 -96 Q-40 -72 -30 -60 M24 -96 Q40 -72 30 -60',
  phone: 'M-24 -96 Q-36 -72 -30 -56 M24 -96 Q46 -100 38 -124',
  point: 'M-24 -96 Q-36 -72 -30 -56 M24 -96 L74 -112',
  talk: 'M-24 -96 Q-52 -100 -58 -126 M24 -96 Q36 -72 30 -56',
  cheer: 'M-24 -96 L-48 -152 M24 -96 L48 -152',
};

function Person({ x, pose, happy = true }: { x: number; pose: Pose; happy?: boolean }) {
  return (
    <g transform={`translate(${x} 340)`}>
      <g className={styles.breathe}>
        <path d="M-13 0 L-10 -50 M13 0 L10 -50" className={styles.line} />
        <path d="M-26 -50 Q-30 -112 0 -114 Q30 -112 26 -50 Z" className={styles.shirt} />
        <path d={ARMS[pose]} className={styles.line} />
        {pose === 'phone' ? <rect x="28" y="-154" width="20" height="32" rx="4" className={styles.paper} /> : null}
        <circle cy="-138" r="22" className={styles.skin} />
        <path d="M-23 -140 Q-22 -164 2 -162 Q25 -161 23 -138 Q8 -152 -23 -140 Z" className={styles.hair} />
        <circle cx="-8" cy="-136" r="2.6" className={styles.dot} />
        <circle cx="8" cy="-136" r="2.6" className={styles.dot} />
        <path d={happy ? 'M-8 -126 Q0 -118 8 -126' : 'M-7 -122 Q0 -128 7 -122'} className={styles.thin} />
      </g>
    </g>
  );
}

function Coach({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={styles.bob}>
        <path d="M-34 0 C-34 -26 -18 -40 0 -40 C18 -40 34 -26 34 0 C34 22 18 34 0 34 L-12 34 L-26 48 L-22 30 C-30 24 -34 14 -34 0 Z"
          className={styles.coach} />
        <circle cx="-11" cy="-4" r="4" className={styles.dot} />
        <circle cx="11" cy="-4" r="4" className={styles.dot} />
        <path d="M-8 10 Q0 17 8 10" className={styles.thin} />
        <path d="M30 -46 l4 -10 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 Z" className={styles.sparkle} />
      </g>
    </g>
  );
}

function Shrub({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 342)`}>
      <g className={styles.sway}>
        <path d="M0 0 Q-4 -30 -22 -40 Q-6 -36 0 -18 Q4 -44 22 -52 Q8 -36 2 0" className={styles.leaf} />
      </g>
    </g>
  );
}

const EMPTY_GRID = [0, 1, 2].flatMap(row => [0, 1, 2].map(col => [347 + col * 11, 214 + row * 11] as const));
const TILE_COLORS = ['mint', 'coral', 'sun', 'lilac', 'mint', 'sun', 'coral', 'lilac', 'mint'] as const;

export function IStoryScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 3600 400" preserveAspectRatio="xMinYMax slice" className={className} focusable="false">
      <path d="M0 340 Q300 318 600 340 T1200 340 T1800 340 T2400 340 T3000 340 T3600 340 V400 H0 Z" className={styles.ground} />
      <path d="M0 366 Q300 350 600 366 T1200 366 T1800 366 T2400 366 T3000 366 T3600 366" className={styles.road} />
      {[620, 1230, 1800, 2420, 3020].map(x => <Shrub key={x} x={x} />)}

      {/* 1 · a blank account */}
      <g>
        <g transform="translate(300 118)">
          <g className={styles.sway}>
            <path d="M-46 14 Q-50 -12 -22 -14 Q-12 -38 14 -30 Q40 -34 42 -6 Q60 0 52 18 Z" className={styles.cloud} />
            <path d="M-6 -10 Q-4 -20 4 -18 Q12 -14 4 -6 Q0 -3 0 4 M0 11 v1" className={styles.thin} />
          </g>
        </g>
        <Person x={290} pose="rest" happy={false} />
        <rect x="200" y="262" width="220" height="78" rx="6" className={styles.paper} />
        <rect x="338" y="194" width="44" height="68" rx="7" className={styles.paper} />
        {EMPTY_GRID.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="8" height="8" rx="1.5" className={styles.dash} />)}
      </g>

      {/* 2 · the coach arrives */}
      <g>
        <g transform="translate(796 118)">
          <g className={styles.twinkle}>
            <path d="M0 -36 v-12 M-26 -26 l-8 -8 M26 -26 l8 -8" className={styles.thin} />
          </g>
          <circle r="17" className={styles.sun} />
          <path d="M-7 18 h14 v10 h-14 Z" className={styles.paper} />
        </g>
        <Person x={840} pose="phone" />
        <g className={styles.pop}>
          <rect x="878" y="102" width="96" height="36" rx="16" className={styles.mintSoft} />
          <path d="M894 116 h58 M894 126 h38" className={styles.thin} />
        </g>
        <g className={styles.popLate}>
          <rect x="944" y="150" width="84" height="32" rx="14" className={styles.coralSoft} />
          <path d="M958 163 h50 M958 172 h30" className={styles.thin} />
        </g>
        <Coach x={1000} y={244} />
      </g>

      {/* 3 · accounts to learn from */}
      <g>
        <Person x={1340} pose="point" />
        {[1430, 1520, 1610].map(x => (
          <g key={x}>
            <rect x={x} y="172" width="76" height="98" rx="10" className={styles.paper} />
            <circle cx={x + 38} cy="200" r="13" className={styles.lilacSoft} />
            <path d={`M${x + 16} 232 h44 M${x + 16} 246 h30`} className={styles.thin} />
          </g>
        ))}
        <g transform="translate(1558 222)">
          <g className={styles.sway}>
            <circle r="36" className={styles.lens} />
            <path d="M26 26 L58 60" className={styles.handle} />
          </g>
        </g>
        <Coach x={1740} y={250} />
      </g>

      {/* 4 · the report */}
      <g>
        <Person x={2040} pose="point" />
        <rect x="2124" y="112" width="136" height="190" rx="10" className={styles.paper} />
        <rect x="2124" y="112" width="136" height="26" rx="10" className={styles.coralFill} />
        {[166, 204, 242].map(y => (
          <g key={y}>
            <path d={`M2140 ${y} l8 8 l14 -16`} className={styles.check} />
            <path d={`M2172 ${y + 2} h70`} className={styles.thin} />
          </g>
        ))}
        <path d="M2300 120 l5 -12 l5 12 l12 5 l-12 5 l-5 12 l-5 -12 l-12 -5 Z" className={styles.twinkleStar} />
        <path d="M2094 96 l4 -9 l4 9 l9 4 l-9 4 l-4 9 l-4 -9 l-9 -4 Z" className={styles.twinkleStarLate} />
        <Coach x={2330} y={256} />
      </g>

      {/* 5 · filming */}
      <g>
        <Person x={2680} pose="talk" />
        <path d="M2638 196 q-12 -4 -18 -14 M2636 212 q-14 0 -22 -6" className={styles.twinkleLine} />
        <circle cx="2802" cy="176" r="46" className={styles.ring} />
        <rect x="2788" y="150" width="28" height="50" rx="5" className={styles.paper} />
        <path d="M2802 200 V300 M2802 300 L2776 340 M2802 300 L2828 340 M2802 300 V340" className={styles.line} />
        <g transform="translate(2900 200)">
          <g className={styles.bob}>
            <rect x="-24" y="-18" width="48" height="36" rx="8" className={styles.coralSoft} />
            <path d="M-6 -8 L10 0 L-6 8 Z" className={styles.coralFill} />
          </g>
        </g>
        <Coach x={2950} y={262} />
      </g>

      {/* 6 · the account is running */}
      <g>
        <Person x={3230} pose="cheer" />
        <rect x="3330" y="110" width="116" height="206" rx="16" className={styles.paper} />
        <circle cx="3388" cy="138" r="12" className={styles.mintSoft} />
        {TILE_COLORS.map((color, index) => (
          <rect key={index} x={3342 + (index % 3) * 32} y={162 + Math.floor(index / 3) * 32} width="28" height="28" rx="5"
            className={styles[`${color}Tile`]} />
        ))}
        <g transform="translate(3376 96)">
          <path d="M0 6 C-10 -4 -4 -14 0 -8 C4 -14 10 -4 0 6 Z" className={styles.heart} />
        </g>
        <g transform="translate(3420 92)">
          <path d="M0 6 C-10 -4 -4 -14 0 -8 C4 -14 10 -4 0 6 Z" className={styles.heartLate} />
        </g>
        <g transform="translate(3350 84)">
          <rect x="-14" y="-10" width="28" height="20" rx="8" className={styles.bubbleRise} />
        </g>
        <g transform="translate(3520 342)">
          <g className={styles.sway}>
            <path d="M-16 0 L-20 -30 H20 L16 0 Z" className={styles.coralFill} />
            <path d="M0 -30 V-96 M0 -60 Q-26 -66 -30 -88 Q-8 -84 0 -66 M0 -78 Q22 -86 30 -108 Q6 -104 0 -86" className={styles.leaf} />
          </g>
        </g>
        <Coach x={3540} y={168} />
      </g>
    </svg>
  );
}

/** The far layer: clouds, a few birds and the sun, panned slower than the panorama. */
export function IStorySky({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1800 400" preserveAspectRatio="xMinYMax slice" className={className} focusable="false">
      {[[160, 120], [560, 80], [980, 130], [1300, 70]].map(([x, y]) => (
        <g key={x} transform={`translate(${x} ${y})`}>
          <g className={styles.drift}>
            <path d="M-60 16 Q-64 -10 -32 -12 Q-20 -38 10 -30 Q44 -36 46 -6 Q70 0 60 16 Z" className={styles.cloudFar} />
          </g>
        </g>
      ))}
      <path d="M700 170 q8 -8 16 0 q8 -8 16 0 M760 150 q6 -6 12 0 q6 -6 12 0" className={styles.bird} />
      <g transform="translate(1640 140)">
        <g className={styles.spin}>
          <path d="M0 -62 V-48 M0 48 V62 M-62 0 H-48 M48 0 H62 M-44 -44 l10 10 M34 34 l10 10 M-44 44 l10 -10 M34 -34 l10 -10"
            className={styles.ray} />
        </g>
        <circle r="34" className={styles.sunFar} />
      </g>
    </svg>
  );
}
