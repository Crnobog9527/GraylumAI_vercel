/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  REPORT_DATA_FENCE, brokenReportDataLimit, fitReportData, joinReportBody, jsonBytes, parseReportBody, parseReportDataBlock,
  reportBodyText, reportDataCharacters, reportDataGroup, splitReportBody, type ReportData,
} from './reportData';
import { REPORT_DATA_CHAPTER, REPORT_DATA_FIELDS, REPORT_DATA_FIELD_NAMES, REPORT_DATA_GROUPS, REPORT_DATA_LIMITS } from './reportDataSpec';
import { SAMPLE_REPORT_DATA, sampleReportDataBlock } from './reportDataSample';

const block = (...rows: unknown[]) => [REPORT_DATA_FENCE, ...rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)), '```'].join('\n');
const row = (field: string, value: unknown) => ({ v: 1, field, value });

describe('splitReportBody', () => {
  const text = '## 一句话结论\n\n先做小红书。';
  it('keeps a body without a block as it is', () => {
    expect(splitReportBody(text)).toEqual({ text, block: null, pending: false });
  });
  it('separates the text from a closed block, and joins them back unchanged', () => {
    const data = block(row('summary', '先做小红书'));
    const parts = splitReportBody(`${text}\n\n${data}\n`);
    expect(parts).toEqual({ text, block: data, pending: false });
    expect(joinReportBody(parts.text + '\n改了一句。', parts.block)).toBe(`${text}\n改了一句。\n\n${data}`);
    expect(reportBodyText(`${text}\n\n${data}`)).toBe(text);
  });
  it('hides a block still being written (or cut off) and says so', () => {
    expect(splitReportBody(`${text}\n\n${REPORT_DATA_FENCE}\n{"v":1,"field":"summ`)).toEqual({ text, block: null, pending: true });
    expect(parseReportBody(`${text}\n\n${REPORT_DATA_FENCE}\n{"v":1`).data).toBeNull();
  });
  it('takes the last block, so a fence typed into the text cannot replace the data', () => {
    const typed = block(row('summary', '用户写的'));
    const real = block(row('summary', '生成的'));
    const body = joinReportBody(`${text}\n\n${typed}`, real);
    expect(splitReportBody(body)).toEqual({ text: `${text}\n\n${typed}`, block: real, pending: false });
    expect(parseReportBody(body).data!.data.summary).toBe('生成的');
  });
  it('never lets a data line look like a chapter heading', () => {
    const body = `${text}\n\n${sampleReportDataBlock()}`;
    expect(body.split('\n').filter(line => /^##\s+/.test(line))).toEqual(['## 一句话结论']);
  });
});

describe('parseReportDataBlock', () => {
  it('accepts the full sample: every field, nothing dropped, within every limit', () => {
    const parsed = parseReportDataBlock(sampleReportDataBlock());
    expect(parsed.dropped).toEqual([]);
    expect(Object.keys(parsed.data).sort()).toEqual([...REPORT_DATA_FIELD_NAMES].sort());
    expect(parsed.data).toEqual(SAMPLE_REPORT_DATA);
    expect(brokenReportDataLimit(parsed.data)).toBeNull();
  });

  it('loses only the broken line, an unknown version or an unknown field', () => {
    const parsed = parseReportDataBlock(block(row('summary', '一句话'), '{"v":1,"field":"thisWeek","value":[', { v: 2, field: 'redLines', value: ['x'] },
      row('nope', 1), row('redLines', ['不承诺收益'])));
    expect(parsed.data).toEqual({ summary: '一句话', redLines: ['不承诺收益'] });
    expect(parsed.dropped).toEqual(['#line2', '#line3', '#line4']);
  });

  it('drops a field that does not pass and keeps its text for a plain list', () => {
    const parsed = parseReportDataBlock(block(row('goal', { primary: '涨粉', outcome: '接单', feasibility: 'maybe', pros: [], cons: [], unknowns: [] })));
    expect(parsed.data.goal).toBeUndefined();
    expect(parsed.dropped).toEqual(['goal']);
    expect(parsed.fallback.goal).toEqual(['涨粉', '接单', 'maybe']);
  });

  it('checks lengths in Unicode characters, and turns links and HTML into nothing special', () => {
    expect(parseReportDataBlock(block(row('summary', '字'.repeat(200)))).data.summary).toHaveLength(200);
    expect(parseReportDataBlock(block(row('summary', '字'.repeat(201)))).dropped).toEqual(['summary']);
    expect(parseReportDataBlock(block(row('summary', '😀'.repeat(200)))).data.summary).toBeDefined();
    const html = '<img src=x onerror=alert(1)> [链接](https://x.test)';
    expect(parseReportDataBlock(block(row('summary', html))).data.summary).toBe(html);
  });

  it('drops bad items of a list, and the whole list when too few remain', () => {
    const good = { action: '注册账号', why: '先占名字', done: '名字和头像设好' };
    const parsed = parseReportDataBlock(block(row('thisWeek', [good, { action: '缺两项' }, good, good])));
    expect(parsed.data.thisWeek).toEqual([good, good, good]);
    expect(parsed.dropped).toEqual(['thisWeek[1]']);
    const none = parseReportDataBlock(block(row('thisWeek', [good, { action: '缺两项' }, good])));
    expect(none.data.thisWeek).toBeUndefined();
    expect(none.dropped).toEqual(['thisWeek']);
    expect(none.fallback.thisWeek).toContain('注册账号');
  });

  it('cuts a list at its maximum and records the rest', () => {
    const topic = SAMPLE_REPORT_DATA.topics![0];
    const parsed = parseReportDataBlock(block(row('topics', Array.from({ length: 14 }, () => topic))));
    expect(parsed.data.topics).toHaveLength(12);
    expect(parsed.dropped).toEqual(['topics[12]', 'topics[13]']);
  });

  it('drops a bad optional part only, and never takes numbers the model wrote for benchmarks', () => {
    const groups = SAMPLE_REPORT_DATA.audience!.groups.map(group => ({ ...group, quote: 42 }));
    const parsed = parseReportDataBlock(block(row('audience', { ...SAMPLE_REPORT_DATA.audience, groups }),
      row('benchmarks', { accounts: [{ platform: '小红书', account: '甜点A', category: '同城', takeaway: '学开头', metrics: { followers: 1e9 } }] })));
    expect(parsed.data.audience!.groups.every(group => group.quote === undefined)).toBe(true);
    expect(parsed.dropped).toContain('audience.groups[0].quote');
    expect(parsed.data.benchmarks!.accounts[0]).not.toHaveProperty('metrics');
  });

  it('keeps the first of a repeated field', () => {
    const parsed = parseReportDataBlock(block(row('summary', '第一'), row('summary', '第二')));
    expect(parsed.data.summary).toBe('第一');
    expect(parsed.dropped).toEqual(['summary#duplicate']);
  });

  it('drops a benchmark account that is not in the host table', () => {
    const accounts = [
      { platform: '小红书', account: '甜点A', category: '同城', takeaway: '学开头' },
      { platform: '抖音', account: '编的号', category: '同城', takeaway: '学结尾' },
    ];
    const parsed = parseReportDataBlock(block(row('benchmarks', { accounts })), { benchmarkAccounts: [{ platform: '小红书', account: ' 甜点a ' }] });
    expect(parsed.data.benchmarks!.accounts.map(account => account.account)).toEqual(['甜点A']);
    expect(parsed.dropped).toEqual(['benchmarks.accounts[1]']);
  });
});

describe('limits (Owner choice B)', () => {
  const long = (n: number) => '字'.repeat(n);
  it('counts characters of the texts only, and bytes per group', () => {
    expect(reportDataCharacters({ a: '一二', b: ['三', { c: 'ab' }], d: 4 })).toBe(5);
    expect(jsonBytes(reportDataGroup({ summary: '字', funnel: [] } as ReportData, 'content'))).toBe(jsonBytes({ summary: '字' }));
  });

  it('drops in the fixed order until the 9000-character limit holds', () => {
    const data = structuredClone(SAMPLE_REPORT_DATA);
    data.summary = long(200);
    data.topics = Array.from({ length: 12 }, () => ({ title: long(120), forWhom: long(120), pain: long(120), howToShoot: long(120),
      tests: long(120), watch: long(120) }));
    const dropped: string[] = [];
    fitReportData(data, dropped);
    expect(brokenReportDataLimit(data)).toBeNull();
    expect(dropped.slice(0, 3)).toEqual(['adjustments', 'routine', 'compliance']);
    expect(dropped[3]).toBe('topics[11]');
    expect(data.summary).toBeDefined();
  });

  it('drops business fields first when the business group is over its bytes', () => {
    const data = structuredClone(SAMPLE_REPORT_DATA);
    const dropped: string[] = [];
    fitReportData(data, dropped, { ...REPORT_DATA_LIMITS, businessBytes: jsonBytes(reportDataGroup(data, 'business')) - 1 });
    expect(dropped).toEqual([`assumptions[${SAMPLE_REPORT_DATA.assumptions!.length - 1}]`]);
    expect(data.funnel).toBeDefined();
  });

  it('always ends, at worst with nothing left', () => {
    const data = structuredClone(SAMPLE_REPORT_DATA);
    const dropped: string[] = [];
    fitReportData(data, dropped, { ...REPORT_DATA_LIMITS, characters: 0 });
    expect(data).toEqual({});
    expect(dropped.at(-1)).toBe('summary');
    expect(dropped.at(-2)).toBe('thisWeek');
  });
});

describe('field definitions', () => {
  it('puts every field in exactly one group and one chapter', () => {
    const grouped = [...REPORT_DATA_GROUPS.content, ...REPORT_DATA_GROUPS.business];
    expect(grouped.sort()).toEqual([...REPORT_DATA_FIELD_NAMES].sort());
    expect(Object.keys(REPORT_DATA_CHAPTER).sort()).toEqual([...REPORT_DATA_FIELD_NAMES].sort());
  });
  it('has the review-required columns: pass criteria per week, advice per compliance item', () => {
    const weeks = REPORT_DATA_FIELDS.plan30.fields.weeks.of.fields;
    expect(weeks.passIf.label).toBe('怎样算过关');
    expect(REPORT_DATA_FIELDS.compliance.of.fields.advice.label).toBe('具体该怎么做');
  });
});
