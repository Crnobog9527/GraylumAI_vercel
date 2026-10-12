/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { PUBLISH_PLATFORMS, type FlowMock } from '@/lib/landing/landing-flow';
import { cn } from '@/lib/utils';
import styles from './flow.module.css';

/**
 * One screen mock per walk-through step. Layout and labels follow the real product screens; text is drawn as
 * neutral placeholder lines so no account, number or report wording is invented (offer brief section 12).
 * Visible labels only reuse words from the step's own final copy. Decorative: hidden from screen readers,
 * the step title and caption next to it carry the meaning.
 */
const delay = (seconds: number) => ({ '--d': `${seconds}s` } as CSSProperties);

function Line({ width, gold }: { width: string; gold?: boolean }) {
  return <span className={cn(styles.line, gold && styles.lineGold)} style={{ width }} />;
}

function Seq({ at, className, children }: { at: number; className?: string; children: ReactNode }) {
  return <div className={cn(styles.seq, className)} style={delay(at)}>{children}</div>;
}

function Bubble({ coach, children }: { coach?: boolean; children: ReactNode }) {
  return (
    <div className={cn('grid gap-2 rounded-xl p-3', coach ? 'mr-6 bg-[#1C1C1C]' : 'ml-10 bg-[#FFD700]/10')}>{children}</div>
  );
}

function Frame({ children, side }: { children: ReactNode; side?: ReactNode }) {
  return (
    <div className={styles.window}>
      <div className={styles.bar}><span className={styles.dot} /><span className={styles.dot} /><span className={styles.dot} /></div>
      <div className={cn('grid gap-3 p-4', side ? 'sm:grid-cols-[1fr_38%]' : '')}>
        <div className="grid content-start gap-3">{children}</div>
        {side ? <div className="grid content-start gap-2 rounded-xl border border-[#262626] bg-[#0E0E0E] p-3">{side}</div> : null}
      </div>
    </div>
  );
}

const chipGold = cn(styles.chip, 'bg-[#FFD700]/15 text-[#FFD700]');
const chipGrey = cn(styles.chip, 'bg-[#1F1F1F] text-[#B0B0B0]');

function ChatMock() {
  return (
    <Frame side={<>
      <span className={chipGrey}>笔记</span>
      <Seq at={1.6}><Line width="85%" /></Seq>
      <Seq at={2.0}><Line width="65%" /></Seq>
      <Seq at={2.4}><Line width="75%" /></Seq>
      <Seq at={3.0} className={cn(styles.pulse, 'mt-2 grid gap-2 rounded-lg border border-[#FFD700]/40 p-2')}>
        <span className={chipGold}>小结</span>
        <Line width="90%" />
        <span className="w-fit rounded-md bg-[#FFD700] px-3 py-1 text-xs font-semibold text-[#0A0A0A]">确认</span>
      </Seq>
    </>}>
      <Bubble coach><Line width="80%" /><Line width="55%" /><span className={chipGrey}>例子</span></Bubble>
      <div className="grid gap-2">
        {[0, 1, 2].map(index => (
          <div key={index} className={cn('flex items-center justify-between gap-2 rounded-lg border border-[#2A2A2A] px-3 py-2',
            index === 0 && cn(styles.pick, styles.picked))} style={index === 0 ? delay(0.8) : undefined}>
            <Line width={['60%', '50%', '45%'][index]} />
            {index === 0 ? <span className={chipGold}>推荐</span> : null}
          </div>
        ))}
      </div>
      <Seq at={1.2}><Bubble><Line width="70%" gold /></Bubble></Seq>
    </Frame>
  );
}

function TruthMock() {
  return (
    <Frame>
      <Bubble coach>
        <Line width="85%" />
        <div className={cn(styles.strike, styles.struck)} style={delay(0.6)}><Line width="60%" /></div>
        <Seq at={0.9}><span className={cn(styles.chip, 'bg-amber-500/15 text-amber-300')}>难变现</span></Seq>
      </Bubble>
      <Seq at={1.6} className="grid gap-2 rounded-xl border border-[#FFD700]/40 bg-[#FFD700]/5 p-3">
        <span className={chipGold}>调整方案</span>
        <Line width="90%" gold />
        <Line width="70%" />
      </Seq>
    </Frame>
  );
}

function ResearchMock() {
  return (
    <Frame>
      <div className="flex items-center gap-2 rounded-lg border border-[#2A2A2A] px-3 py-2 text-xs text-[#8A8A8A]">链接或关键词</div>
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map(group => (
          <Seq key={group} at={0.6 + group * 0.3} className="grid content-start gap-1.5 rounded-lg bg-[#1A1A1A] p-2">
            <Line width="50%" />
            {[0, 1].map(item => (
              <div key={item} className="flex items-center gap-1.5">
                <span className={cn('flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-[#3A3A3A]',
                  item === 0 && 'border-[#FFD700] bg-[#FFD700]')}>{item === 0 ? <Check className="h-3 w-3 text-[#0A0A0A]" /> : null}</span>
                <Line width="70%" />
              </div>
            ))}
          </Seq>
        ))}
      </div>
      <Seq at={1.8} className="overflow-hidden rounded-lg border border-[#262626] text-[11px] text-[#B0B0B0]">
        <div className="grid grid-cols-4 gap-2 bg-[#1A1A1A] px-2 py-1.5">
          <span /><span>播放中位数</span><span>互动率</span><span>更新频率</span>
        </div>
        {[0, 1, 2].map(row => (
          <div key={row} className="grid grid-cols-4 items-center gap-2 border-t border-[#222] px-2 py-1.5">
            <Line width="70%" />
            <Line width="50%" gold />
            {row === 2 ? <span className="text-[#8A8A8A]">未取到</span> : <Line width="40%" gold />}
            <Line width="45%" gold />
          </div>
        ))}
      </Seq>
    </Frame>
  );
}

function ReportMock() {
  const headings = ['一句话定位', '账号三件套', '对标拆解', '第一个 30 天计划', '变现路线'];
  return (
    <Frame>
      {headings.map((heading, index) => (
        <Seq key={heading} at={0.3 + index * 0.35} className="grid gap-1.5 border-l-2 border-[#FFD700]/50 pl-3">
          <span className="text-xs font-semibold text-white">{heading}</span>
          <Line width={`${80 - index * 6}%`} />
        </Seq>
      ))}
    </Frame>
  );
}

function LibraryMock() {
  return (
    <Frame side={<>
      {['定位档案', '文件', '文风画像'].map((item, index) => (
        <Seq key={item} at={0.4 + index * 0.3} className="grid gap-1.5 rounded-lg bg-[#1A1A1A] p-2">
          <span className="text-xs font-semibold text-[#E5E5E5]">{item}</span><Line width="70%" />
        </Seq>
      ))}
    </>}>
      <Bubble><span className="text-sm text-white">这周发什么</span></Bubble>
      <Seq at={1.4}><Bubble coach><Line width="85%" /><Line width="75%" gold /><Line width="60%" /></Bubble></Seq>
    </Frame>
  );
}

function VoiceMock() {
  return (
    <Frame>
      <Seq at={0.2} className="grid gap-1.5 rounded-xl bg-[#1A1A1A] p-3">
        <span className="text-xs text-[#B0B0B0]">你写过的东西</span><Line width="85%" /><Line width="70%" />
      </Seq>
      <Seq at={0.9} className="flex flex-wrap items-center gap-2 rounded-xl border border-[#2A2A2A] p-3">
        <span className={chipGold}>文风画像</span><Line width="40%" />
        <span className={cn(styles.pulse, 'rounded-md bg-[#FFD700] px-3 py-1 text-xs font-semibold text-[#0A0A0A]')} style={delay(1.3)}>确认</span>
      </Seq>
      <div className="grid grid-cols-2 gap-2">
        <Seq at={2.0} className="grid gap-1.5 rounded-lg bg-[#1A1A1A] p-2"><Line width="90%" /><Line width="75%" /><Line width="80%" /></Seq>
        <Seq at={2.4} className="grid gap-1.5 rounded-lg bg-[#FFD700]/5 p-2"><Line width="88%" gold /><Line width="78%" gold /><Line width="70%" gold /></Seq>
      </div>
    </Frame>
  );
}

function PublishMock() {
  return (
    <Frame>
      <div className="grid gap-1.5 rounded-xl bg-[#1A1A1A] p-3"><Line width="80%" /><Line width="60%" /></div>
      <span className={cn(styles.pulse, 'w-fit rounded-md bg-[#FFD700] px-3 py-1 text-xs font-semibold text-[#0A0A0A]')} style={delay(0.3)}>一键发</span>
      <div className="flex flex-wrap gap-1.5">
        {PUBLISH_PLATFORMS.map((platform, index) => (
          <Seq key={platform} at={0.9 + index * 0.12}><span className={chipGrey}><Check className="h-3 w-3 text-[#4ADE80]" />{platform}</span></Seq>
        ))}
      </div>
    </Frame>
  );
}

function ReviewMock() {
  return (
    <Frame>
      {[0, 1, 2].map(row => (
        <Seq key={row} at={0.3 + row * 0.3} className="flex items-center justify-between gap-2 rounded-lg bg-[#1A1A1A] px-3 py-2">
          <Line width="55%" />
          {row === 1 ? <span className={cn(styles.chip, 'bg-[#22C55E]/15 text-[#4ADE80]')}>有效</span> : <Line width="15%" />}
        </Seq>
      ))}
      <Seq at={1.5} className="grid gap-2 rounded-xl border border-[#FFD700]/40 bg-[#FFD700]/5 p-3">
        <span className={chipGold}>下周怎么调</span><Line width="85%" gold /><Line width="65%" />
      </Seq>
    </Frame>
  );
}

function FusionMock() {
  return (
    <Frame>
      <div className="grid grid-cols-3 gap-2">
        {['A', 'B', 'C'].map((name, index) => (
          <Seq key={name} at={0.3 + index * 0.25} className="grid gap-1.5 rounded-lg bg-[#1A1A1A] p-2">
            <span className="text-xs font-semibold text-[#E5E5E5]">模型 {name}</span><Line width="85%" /><Line width="65%" />
          </Seq>
        ))}
      </div>
      <Seq at={1.3}><span className={chipGrey}>交叉挑错</span></Seq>
      <div className="grid grid-cols-2 gap-2">
        <Seq at={1.8} className="grid gap-1.5 rounded-lg bg-[#1A1A1A] p-2"><span className="text-xs text-[#8A8A8A]">原稿</span><Line width="80%" /></Seq>
        <Seq at={2.1} className="grid gap-1.5 rounded-lg bg-[#FFD700]/5 p-2"><span className="text-xs text-[#FFD700]">修订版</span><Line width="85%" gold /></Seq>
      </div>
    </Frame>
  );
}

const MOCKS: Record<FlowMock, () => ReactNode> = {
  chat: ChatMock, truth: TruthMock, research: ResearchMock, report: ReportMock, library: LibraryMock,
  voice: VoiceMock, publish: PublishMock, review: ReviewMock, fusion: FusionMock,
};

export function FlowMockView({ mock }: { mock: FlowMock }) {
  const Mock = MOCKS[mock];
  return <div aria-hidden="true"><Mock /></div>;
}
