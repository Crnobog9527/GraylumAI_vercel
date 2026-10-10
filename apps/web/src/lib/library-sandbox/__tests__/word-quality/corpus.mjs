/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB_DOCS_PLAN §4.5 Word quality corpus: 20 fixed Chinese/English documents, all text written for
// this test (no real user data). Each sample is a structured spec; the reference ("gold") text is
// derived from the spec as a person reading the document would see it, independently of the
// extractor. LibreOffice and macOS textutil samples come from the spec through a real Word writer;
// `raw` samples are hand-written OOXML for Word-specific constructs.

const CN = [
  '做账号定位之前，先想清楚你能长期稳定输出什么内容。',
  '目标受众不是越多越好，而是越清楚越好。',
  '每条笔记只讲一个核心观点，标题里直接写出读者能得到的好处。',
  '复盘时先看完播率，再看互动率，最后才看涨粉数。',
  '同一个选题可以换三种角度写：经验、清单和避坑。',
  '封面图的文字不要超过十二个字，手机上要一眼看清。',
  '评论区的高频问题，往往就是下一篇内容的选题。',
  '发布时间要固定，让老读者形成期待。',
  '不要同时追五个热点，选一个和自己定位最贴近的。',
  '数据好的内容要拆解原因，数据差的内容也要记下来。',
  '小红书的搜索流量比推荐流量更稳定，关键词要写进正文。',
  '视频前三秒决定用户会不会继续看下去。',
  '合作报价要参考粉丝量、互动率和垂直程度三个因素。',
  '私域运营的核心是持续提供价值，而不是频繁推销。',
  '每周留出半天时间整理素材库，避免临时找选题。',
  '把常用的开头和结尾做成模板，可以节省大量时间。',
  '用户愿意收藏的内容，通常是可以反复使用的方法。',
  '账号起步阶段，先把一种内容形式做熟，再考虑扩展。',
  '直播前准备好产品顺序、讲解要点和常见问题的回答。',
  '长期主义不是口号，而是每天按计划完成一点点。',
];

const EN = [
  'Before choosing a niche, decide what you can publish consistently for a year.',
  'A clear audience beats a large one when you are starting out.',
  'Each post should carry one idea, and the headline should state the benefit.',
  'Review completion rate first, engagement second, and follower growth last.',
  'One topic can be told three ways: as a story, as a checklist, or as mistakes to avoid.',
  'Keep thumbnail text under six words so it reads on a phone.',
  'The questions people repeat in comments are your next topics.',
  'Publish on a fixed schedule so returning readers know when to come back.',
  'Do not chase five trends at once; pick the one closest to your positioning.',
  'Break down why strong posts worked, and keep notes on the weak ones too.',
  'Search traffic is steadier than feed traffic, so put keywords in the body.',
  'The first three seconds of a video decide whether people keep watching.',
  'Price partnerships on audience size, engagement, and how focused the account is.',
  'Community building is about steady value, not constant selling.',
  'Set aside half a day each week to organise your material library.',
  'Templates for openings and closings save more time than any tool.',
  'Content people save is usually a method they can use again.',
  'Master one format before you add another.',
  'Before a live stream, prepare the product order, key points, and common answers.',
  'Long-term thinking is not a slogan; it is a small step completed every day.',
];

/** Deterministic sentence picker so the long documents are fixed. */
function picker(pool, seed) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return pool[state % pool.length];
  };
}

const paragraph = (next, count, glue) => Array.from({ length: count }, next).join(glue);

function longDocument(lang, sections) {
  const next = picker(lang === 'zh' ? CN : EN, lang === 'zh' ? 11 : 29);
  const glue = lang === 'zh' ? '' : ' ';
  const blocks = [{ h: 1, text: lang === 'zh' ? '内容运营手册（长文）' : 'Content Operations Handbook' }];
  for (let s = 1; s <= sections; s += 1) {
    blocks.push({ h: 2, text: lang === 'zh' ? `第${s}部分 实操要点` : `Part ${s}: Practice Notes` });
    for (let t = 1; t <= 3; t += 1) {
      blocks.push({ h: 3, text: lang === 'zh' ? `${s}.${t} 具体做法` : `${s}.${t} How to do it` });
      for (let p = 0; p < 4; p += 1) blocks.push({ p: paragraph(next, 4, glue) });
    }
  }
  return blocks;
}

const LINK = 'https://example.invalid/should-never-be-requested';

/** Specs rendered through LibreOffice (FODT → DOCX) or macOS textutil (HTML → DOCX). */
export const SPEC_SAMPLES = [
  { id: '01-cn-headings', producer: 'libreoffice', blocks: [
    { h: 1, text: '账号定位指南' }, { p: CN.slice(0, 3).join('') },
    { h: 2, text: '一、明确目标受众' }, { p: CN.slice(3, 6).join('') },
    { h: 3, text: '1. 受众画像' }, { p: CN.slice(6, 8).join('') },
    { h: 2, text: '二、确定内容方向' }, { p: CN.slice(8, 12).join('') },
  ] },
  { id: '02-en-headings', producer: 'libreoffice', blocks: [
    { h: 1, text: 'Positioning Guide' }, { p: EN.slice(0, 3).join(' ') },
    { h: 2, text: 'Know Your Audience' }, { p: EN.slice(3, 6).join(' ') },
    { h: 3, text: 'Audience Profile' }, { p: EN.slice(6, 8).join(' ') },
    { h: 2, text: 'Choose a Direction' }, { p: EN.slice(8, 12).join(' ') },
  ] },
  { id: '03-cn-table', producer: 'libreoffice', blocks: [
    { h: 1, text: '月度数据汇总' }, { p: CN[3] },
    { table: [['平台', '发布数', '播放量', '互动率'], ['小红书', '12', '3.4万', '6.2%'], ['抖音', '20', '12.8万', '3.1%'],
      ['视频号', '8', '1.1万', '4.5%']] },
    { p: CN[9] },
  ] },
  { id: '04-en-nested-table', producer: 'libreoffice', blocks: [
    { h: 1, text: 'Campaign Plan' },
    { table: [['Week', 'Theme', 'Formats'], ['1', 'Launch teaser', { table: [['Reel', 'Story'], ['Carousel', 'Live']] }],
      ['2', 'Customer stories', 'Long post']] },
    { p: EN[12] },
  ] },
  { id: '05-cn-header-footer', producer: 'libreoffice', header: '内部资料 请勿外传', footer: 'page', blocks: [
    { h: 1, text: '季度复盘' }, { p: CN.slice(9, 12).join('') }, { p: CN.slice(12, 14).join('') },
  ] },
  { id: '06-en-footnotes', producer: 'libreoffice', blocks: [
    { h: 1, text: 'Research Notes' },
    { p: ['Search traffic is steadier than feed traffic', { note: 'Based on our own account data over six months.' },
      ', so keywords matter', { note: 'Keywords should appear in the first paragraph.' }, '.'] },
    { p: EN[15] },
  ] },
  { id: '07-cn-endnotes', producer: 'libreoffice', blocks: [
    { h: 1, text: '直播准备清单' },
    { p: ['直播前准备好产品顺序', { note: '先介绍爆款，再介绍新品。' }, '和常见问题的回答', { endnote: '常见问题来自评论区整理。' }, '。'] },
    { p: CN[18] },
  ] },
  { id: '08-mixed-links', producer: 'libreoffice', blocks: [
    { h: 1, text: '参考资料 References' },
    { p: ['完整模板见', { link: '素材库链接', href: LINK }, '，English version: ', { link: 'template library', href: LINK }, '.'] },
    { p: [{ link: '纯链接段落', href: LINK }] },
  ] },
  { id: '09-cn-lists', producer: 'libreoffice', blocks: [
    { h: 1, text: '发布前检查' },
    { list: ['标题写出读者能得到的好处', '封面文字不超过十二个字', { list: ['手机上预览一次', '检查错别字'] }, '正文写进关键词'], ordered: true },
    { p: '注意事项：' },
    { list: ['固定发布时间', '回复前十条评论'], ordered: false },
  ] },
  { id: '10-en-lists', producer: 'libreoffice', blocks: [
    { h: 1, text: 'Weekly Routine' },
    { list: ['Plan topics on Monday', 'Batch filming on Tuesday', 'Edit and schedule on Wednesday'], ordered: true },
    { list: ['Reply to comments daily', 'Review numbers on Friday'], ordered: false },
  ] },
  { id: '11-cn-long', producer: 'libreoffice', blocks: longDocument('zh', 20) },
  { id: '12-en-long', producer: 'libreoffice', blocks: longDocument('en', 16) },
  { id: '13-mixed-report', producer: 'libreoffice', header: 'Graylum 示例报告', footer: 'page', blocks: [
    { h: 1, text: '账号诊断报告 Account Review' },
    { h: 2, text: '一、现状' }, { p: [CN[3], { note: '数据截至上月末。' }] },
    { table: [['指标 Metric', '数值 Value'], ['完播率', '38%'], ['Engagement', '5.4%']] },
    { h: 2, text: '二、建议 Recommendations' },
    { list: [CN[2], EN[6], CN[7]], ordered: true },
    { p: ['详见', { link: '附录', href: LINK }, '。'] },
    { h: 3, text: '2.1 下一步' }, { p: CN[19] },
  ] },
  { id: '14-cn-plain-textutil', producer: 'textutil', blocks: [
    { p: CN.slice(0, 4).join('') }, { p: CN.slice(4, 8).join('') }, { p: CN.slice(8, 12).join('') },
  ] },
  { id: '15-en-plain-textutil', producer: 'textutil', blocks: [
    { p: EN.slice(0, 4).join(' ') }, { p: EN.slice(4, 8).join(' ') }, { p: EN.slice(8, 12).join(' ') },
  ] },
];

/** Inline segments → text, assigning note numbers in reference order. */
function inlineText(segments, notes) {
  return (typeof segments === 'string' ? [segments] : segments).map((segment) => {
    if (typeof segment === 'string') return segment;
    if (segment.link) return segment.link;
    notes.push(segment.note ?? segment.endnote);
    return `[${notes.length}]`;
  }).join('');
}

function cellText(cell) {
  if (typeof cell === 'string') return cell;
  return cell.table.map((row) => row.map(cellText).join(' ')).join(' ');
}

function listLines(items, ordered, depth, lines) {
  let n = 0;
  for (const item of items) {
    if (typeof item === 'string') {
      n += 1;
      lines.push(`${ordered ? `${n}.` : '•'} ${item}`);
    } else listLines(item.list, ordered, depth + 1, lines);
  }
}

/** Reference text and headings for a spec sample. Page number fields read "1" on the first page. */
export function specGold(spec) {
  const lines = [];
  const headings = [];
  const notes = [];
  if (spec.header) lines.push(spec.header);
  for (const block of spec.blocks) {
    if (block.h) {
      lines.push(block.text);
      headings.push({ level: block.h, text: block.text });
    } else if (block.p !== undefined) lines.push(inlineText(block.p, notes));
    else if (block.table) for (const row of block.table) lines.push(row.map(cellText).join('\t'));
    else if (block.list) listLines(block.list, block.ordered, 0, lines);
  }
  notes.forEach((note, i) => lines.push(`[${i + 1}] ${note}`));
  if (spec.footer === 'page') lines.push('第 1 页');
  return { text: lines.join('\n'), headings };
}
