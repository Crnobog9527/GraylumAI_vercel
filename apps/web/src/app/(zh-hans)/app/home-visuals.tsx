/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { Check, User, X } from 'lucide-react';
import styles from './home-method.module.css';

/**
 * The words the six pictures show, one list per step. Every one is taken from that step's own text in home-steps.ts
 * (its 目的 or 你会得到), so a picture says nothing the Owner's copy does not; home-state.test.tsx holds them to it.
 * The only other text in a picture is step six's week numbers (its copy: "第一个月每周的具体任务").
 */
export const HOME_VISUAL_WORDS = [
  ['起点档案', '变现目标', '赛道', '现有条件', '时间', '精力', '预算'],
  ['谁在看', '谁会买', '谁做决定', '流量来源', '收入来源'],
  ['平台建议', '对标账号', '内容结构', '选题方式', '更新节奏', '变现手段', '可以借鉴', '不适合你'],
  ['需要调整', '能做', '靠什么赚钱', '需要多久', '主要风险'],
  ['账号名称', '简介', '头像方向', '一句话定位'],
  ['内容', '收入'],
] as const;

/**
 * When a part comes in and how. `slot` is its place in the picture's loop (0–11, half a second apart); it rises into
 * place unless it pops (grows from a point) or grows from its left edge. Without motion every part is simply there.
 */
const at = (slot: number, how?: 'pop' | 'grow') => ({ 'data-s': slot, 'data-how': how });
const tick = <Check size={9} strokeWidth={4} />;

/** Step one: the starting record, its three facts ticked off, and what the person can put in. */
function Record() {
  const [title, ...rest] = HOME_VISUAL_WORDS[0];
  return (
    <div className={styles.sheet} {...at(0)}>
      <p className={styles.sheetTitle} {...at(1)}>{title}</p>
      {rest.slice(0, 3).map((word, index) => (
        <p key={word} className={styles.row} {...at(2 + index)}><i {...at(3 + index, 'pop')}>{tick}</i>{word}</p>
      ))}
      <div className={styles.meters} {...at(5)}>
        {rest.slice(3).map((word, index) => <p key={word}>{word}<span><b {...at(6 + index, 'grow')} /></span></p>)}
      </div>
    </div>
  );
}

/** Step two: who watches, who buys, who decides; five kinds of people, the ones who pay marked. */
function People() {
  const [watch, buy, decide, traffic, income] = HOME_VISUAL_WORDS[1];
  return (
    <>
      <p className={styles.chain}>{[watch, buy, decide].map((word, index) => <span key={word} {...at(index)}>{word}</span>)}</p>
      <p className={styles.crowd}>
        {[0, 1, 2, 3, 4].map(index => <i key={index} data-pay={index > 2 || undefined} {...at(3 + index, 'pop')}><User size={22} strokeWidth={1.8} /></i>)}
      </p>
      <p className={styles.legend}><span {...at(8)}>{traffic}</span><span data-pay="" {...at(9)}>{income}</span></p>
    </>
  );
}

/** Step three: the platform that is advised, and a benchmark account taken apart into what to borrow and what not. */
function Benchmark() {
  const [advice, account, ...rest] = HOME_VISUAL_WORDS[2];
  const [borrow, skip] = rest.slice(4);
  return (
    <>
      <p className={styles.platforms}><i {...at(0)} /><i data-on="" {...at(1)}><b {...at(3, 'pop')}>{advice}</b></i><i {...at(2)} /></p>
      <div className={styles.sheet} data-wide="" {...at(4)}>
        <p className={styles.sheetTitle}>{account}</p>
        <div className={styles.pairs}>
          {rest.slice(0, 4).map((word, index) => (
            <p key={word} className={styles.row} {...at(5 + index)}>
              <i data-no={index === 2 || undefined}>{index === 2 ? <X size={9} strokeWidth={4} /> : tick}</i>{word}
            </p>
          ))}
        </div>
        <p className={styles.legend} data-marks="" {...at(9)}><span>{borrow}</span><span data-no="">{skip}</span></p>
      </div>
    </>
  );
}

/** Step four: one clear answer, with the three questions it settles. */
function Verdict() {
  const [adjust, can, ...questions] = HOME_VISUAL_WORDS[3];
  return (
    <>
      <svg className={styles.gauge} viewBox="0 0 200 112" {...at(0)}>
        <path className={styles.gaugeTrack} d="M16 100a84 84 0 0 1 168 0" />
        <path className={styles.gaugeOn} d="M100 16a84 84 0 0 1 84 84" pathLength={1} />
        <path className={styles.needle} d="M100 100 152 46" />
        <circle cx="100" cy="100" r="7" />
      </svg>
      <p className={styles.verdict}><span {...at(1)}>{adjust}</span><strong {...at(7, 'pop')}>{can}</strong></p>
      <p className={styles.chips}>{questions.map((word, index) => <span key={word} {...at(8 + index)}>{word}</span>)}</p>
    </>
  );
}

/** Step five: the account as a stranger meets it (name, picture, a few lines) and the one sentence under it. */
function Profile() {
  const [name, bio, picture, sentence] = HOME_VISUAL_WORDS[4];
  return (
    <>
      <div className={styles.profile} {...at(0)}>
        <i className={styles.face} {...at(1, 'pop')} />
        <div>
          <p><b data-name="" {...at(2, 'grow')} /><em {...at(3)}>{name}</em></p>
          <p><b {...at(4, 'grow')} /><b {...at(4, 'grow')} /><em {...at(5)}>{bio}</em></p>
        </div>
        <em className={styles.faceNote} {...at(2)}>{picture}</em>
      </div>
      <p className={styles.sentence} {...at(7)}><em {...at(8, 'pop')}>{sentence}</em><b {...at(9, 'grow')} /><b {...at(9, 'grow')} /></p>
    </>
  );
}

/** Step six: four weeks of tasks, and the line from content to income. */
function Plan() {
  const [content, income] = HOME_VISUAL_WORDS[5];
  return (
    <>
      <div className={styles.weeks}>
        {[2, 3, 2, 3].map((tasks, week) => (
          <p key={week} {...at(week)}>
            <span>第 {week + 1} 周</span>
            {Array.from({ length: tasks }, (_, task) => <b key={task} {...at(week + 1, 'grow')} />)}
          </p>
        ))}
      </div>
      <p className={styles.path}><span {...at(6)}>{content}</span><i {...at(7, 'grow')} /><span data-pay="" {...at(8, 'pop')}>{income}</span></p>
    </>
  );
}

/** The six pictures, in the steps' order. Decoration: the step's own text beside each says everything they show. */
export const HOME_VISUALS: readonly ReactNode[] = [
  <Record key="record" />, <People key="people" />, <Benchmark key="benchmark" />,
  <Verdict key="verdict" />, <Profile key="profile" />, <Plan key="plan" />,
];
