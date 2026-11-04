import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnStepList } from './turn-step-list';
import type { ReplyStep } from './turn-step-list-model';

const steps: ReplyStep[] = [{ id: '1', tool: 'load_skill', state: 'done', label: '分镜脚本' }, { id: '2', tool: 'research', state: 'done', count: 6 }];
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('TurnStepList (the click that opens the fold is covered by turn-step-list.browser.test.tsx)', () => {
  it('live and nothing written: open, ending with 正在思考…', () => {
    const out = html(<TurnStepList steps={[]} live hasText={false}/>);
    expect(out).toContain('正在思考…');
    expect(out).toContain('data-turn-step-list="open"');
  });
  it('a running step shows its words and no 正在思考…', () => {
    const out = html(<TurnStepList steps={[{ id: '1', tool: 'load_skill', state: 'running', label: '分镜脚本' }]} live hasText={false}/>);
    expect(out).toContain('正在读取「分镜脚本」方法…');
    expect(out).not.toContain('正在思考…');
  });
  it('once the text flows the ended steps fold into one line, with the detail left out until opened', () => {
    const out = html(<TurnStepList steps={steps} live hasText/>);
    expect(out).toContain('data-turn-step-list="folded"');
    expect(out).toContain('已完成 2 个步骤');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('已读取「分镜脚本」方法');
  });
  it('a reply read back from history is folded too, and a failed step is counted in neutral words', () => {
    const out = html(<TurnStepList steps={[...steps, { id: '3', tool: 'read_source', state: 'failed' }]}/>);
    expect(out).toContain('已完成 3 个步骤，其中 1 个没成功');
    expect(out).not.toMatch(/错误|异常/);
  });
  it('nothing to show, nothing rendered; the list is a polite live region', () => {
    expect(html(<TurnStepList steps={[]}/>)).toBe('');
    const out = html(<TurnStepList steps={[{ id: '1', tool: 'research', state: 'running' }]} live/>);
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-live="polite"');
  });
});
