/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB_DOCS_PLAN §4.5 text-PDF quality corpus: 20 fixed Chinese/English PDFs (single column, two
// columns, tables, headers and footers), all text written for this test (no real user data).
// Three producers: LibreOffice (Writer → PDF, embedded open-licence fonts), Chromium print-to-PDF
// (embedded open-licence fonts) and hand-written PDF using predefined CJK CMaps with no embedded font.
// The reference text of every page is derived from the spec as a reader would read the page:
// header, body in order (left column before right column, table rows left to right), footer.

const CN = [
  '做账号定位之前，先想清楚自己能长期稳定输出什么内容，再决定写给谁看。',
  '目标受众越清楚越好，一篇笔记只解决一个具体的问题，读者才愿意收藏。',
  '标题里直接写出读者能得到的好处，比堆砌形容词更容易被点开。',
  '复盘的时候先看完播率，再看互动率，最后才看涨粉数，顺序不要颠倒。',
  '同一个选题可以换三种角度来写：亲身经历、实用清单和常见误区。',
  '封面上的文字控制在十二个字以内，手机屏幕上要一眼就能看清楚。',
  '评论区里反复出现的问题，往往就是下一篇内容最好的选题来源。',
  '发布时间尽量固定下来，让老读者形成期待，也方便自己安排节奏。',
  '不要同时追五个热点，挑一个和自己定位最贴近的认真做透。',
  '数据好的内容要拆解原因，数据差的内容也要记下来，两者同样有价值。',
  '搜索带来的流量比推荐流量更稳定，关键词要自然地写进正文里。',
  '视频的前三秒决定观众会不会继续看下去，开头要直接给出结论。',
  '合作报价要综合考虑粉丝数量、互动比例和内容的垂直程度。',
  '私域运营的核心是持续提供价值，而不是频繁地发广告推销。',
  '每周留出半天时间整理素材库，就不会在截稿前临时找选题。',
  '把常用的开头和结尾整理成模板，可以节省大量重复劳动的时间。',
  '读者愿意收藏的内容，通常是可以反复拿出来使用的具体方法。',
  '起步阶段先把一种内容形式做熟练，再考虑扩展到其他平台。',
  '直播之前准备好产品顺序、讲解要点和常见问题的标准回答。',
  '长期主义不是一句口号，而是每天按照计划完成一点点进度。',
];

const EN = [
  'Before choosing a niche, decide what you can publish consistently for a whole year.',
  'A clear audience beats a large one when you are starting out, so write for one reader.',
  'Each post should carry one idea, and the headline should state the benefit plainly.',
  'Review completion rate first, engagement second, and follower growth last.',
  'One topic can be told three ways: as a personal story, as a checklist, or as mistakes to avoid.',
  'Keep thumbnail text under six words so it can be read on a small phone screen.',
  'The questions people repeat in the comments are the best source of your next topics.',
  'Publish on a fixed schedule so that returning readers know when to come back.',
  'Do not chase five trends at once; pick the one closest to your positioning and go deep.',
  'Study why strong posts worked, and keep notes on weak posts as well; both are useful data.',
  'Search traffic is steadier than feed traffic, so put the words people search for in the text.',
  'The first three seconds of a video decide whether a viewer stays, so lead with the result.',
  'A sponsorship rate should reflect audience size, engagement, and how focused the account is.',
  'Community building works when you keep giving value instead of pushing products every day.',
  'Set aside half a day each week to organise your material, and deadlines stop being a scramble.',
  'Turn the openings and endings you use most into templates and save hours of repeated work.',
  'Readers bookmark what they can use again, which usually means a concrete method or tool.',
  'Master one content format before you expand to other platforms and other formats.',
  'Before a live stream, prepare the product order, the key talking points, and standard answers.',
  'Consistency is not a slogan; it is finishing a small, planned piece of work every day.',
];

const pick = (list, start, count) => Array.from({ length: count }, (_, index) => list[(start + index) % list.length]);
const paragraphs = (list, start, count) => pick(list, start, count).map((p) => ({ p }));

const CN_TABLE = [
  ['平台', '粉丝数', '平均点赞', '发布频率'],
  ['小红书', '1.2万', '356', '每周三篇'],
  ['抖音', '8,600', '1,024', '每周五条'],
  ['视频号', '3,200', '87', '每周两条'],
  ['公众号', '5,400', '42', '每周一篇'],
];
const EN_TABLE = [
  ['Channel', 'Followers', 'Avg. likes', 'Cadence'],
  ['Newsletter', '4,800', '120', 'Weekly'],
  ['YouTube', '12,300', '640', 'Twice a week'],
  ['Instagram', '9,150', '410', 'Daily'],
  ['Podcast', '2,050', '35', 'Biweekly'],
];
const MIXED_TABLE = [
  ['指标 Metric', '本月 This month', '上月 Last month'],
  ['完播率 Completion', '42%', '37%'],
  ['互动率 Engagement', '6.1%', '5.4%'],
  ['新增粉丝 New followers', '1,280', '960'],
];

/** @typedef {{ h?: string, p?: string, table?: string[][], columns?: Block[] }} Block */

export const SPEC_SAMPLES = [
  // LibreOffice Writer → PDF
  { id: '01-cn-single', producer: 'libreoffice', lang: 'cn', pages: [
    [{ h: '账号定位手册' }, ...paragraphs(CN, 0, 5)], [{ h: '内容规划' }, ...paragraphs(CN, 5, 5)], [...paragraphs(CN, 10, 4)]] },
  { id: '02-en-single', producer: 'libreoffice', lang: 'en', pages: [
    [{ h: 'Creator Handbook' }, ...paragraphs(EN, 0, 5)], [{ h: 'Planning' }, ...paragraphs(EN, 5, 5)], [...paragraphs(EN, 10, 4)]] },
  { id: '03-cn-two-column', producer: 'libreoffice', lang: 'cn', pages: [
    [{ h: '双栏排版的复盘笔记' }, { columns: paragraphs(CN, 2, 8) }], [{ columns: paragraphs(CN, 10, 8) }]] },
  { id: '04-en-two-column', producer: 'libreoffice', lang: 'en', pages: [
    [{ h: 'Two-Column Review Notes' }, { columns: paragraphs(EN, 3, 8) }], [{ columns: paragraphs(EN, 11, 8) }]] },
  { id: '05-cn-table', producer: 'libreoffice', lang: 'cn', pages: [
    [{ h: '各平台数据对比' }, { p: CN[0] }, { table: CN_TABLE }, { p: CN[1] }], [{ table: CN_TABLE.slice(0, 3) }, ...paragraphs(CN, 4, 2)]] },
  { id: '06-en-table', producer: 'libreoffice', lang: 'en', pages: [
    [{ h: 'Channel Comparison' }, { p: EN[0] }, { table: EN_TABLE }, { p: EN[1] }]] },
  { id: '07-cn-header-footer', producer: 'libreoffice', lang: 'cn', header: '内部资料 请勿外传', footer: 'cn-page', pages: [
    [{ h: '季度复盘' }, ...paragraphs(CN, 6, 4)], [...paragraphs(CN, 10, 4)], [...paragraphs(CN, 14, 4)]] },
  { id: '08-mixed-report', producer: 'libreoffice', lang: 'mixed', header: 'Graylum 测试报告 Test report', footer: 'en-page', pages: [
    [{ h: '月度报告 Monthly report' }, { p: CN[3] }, { p: EN[3] }, { table: MIXED_TABLE }],
    [{ h: '下一步 Next steps' }, { columns: [...paragraphs(CN, 7, 3), ...paragraphs(EN, 7, 3)] }]] },
  // Chromium print-to-PDF
  { id: '09-cn-chromium', producer: 'chromium', lang: 'cn', pages: [
    [{ h: '选题方法' }, ...paragraphs(CN, 1, 6)], [{ h: '复盘方法' }, ...paragraphs(CN, 8, 6)], [...paragraphs(CN, 15, 5)]] },
  { id: '10-en-chromium-columns', producer: 'chromium', lang: 'en', pages: [
    [{ h: 'Notes in Two Columns' }, { columns: paragraphs(EN, 0, 8) }], [{ columns: paragraphs(EN, 8, 8) }]] },
  { id: '11-mixed-chromium-table', producer: 'chromium', lang: 'mixed', pages: [
    [{ h: '数据表 Data table' }, { table: CN_TABLE }, { table: EN_TABLE }, { p: CN[9] }, { p: EN[9] }]] },
  { id: '12-cn-chromium-header-footer', producer: 'chromium', lang: 'cn', header: '创作者手册 第二版', footer: 'cn-page', pages: [
    [{ h: '直播准备' }, ...paragraphs(CN, 18, 4)], [...paragraphs(CN, 2, 4)], [...paragraphs(CN, 6, 3), { table: CN_TABLE.slice(0, 3) }]] },
  // Hand-written PDF (no embedded fonts; predefined CMaps)
  { id: '13-raw-unigb-ucs2', producer: 'raw', font: 'SC', lang: 'cn', pages: [
    [{ h: '简体中文：UniGB-UCS2-H' }, ...paragraphs(CN, 0, 6)], [...paragraphs(CN, 6, 6)]] },
  { id: '14-raw-unicns-traditional', producer: 'raw', font: 'TC', lang: 'cn', pages: [
    [{ h: '繁體中文：UniCNS-UCS2-H' }, { p: '帳號定位之前，先想清楚自己能長期穩定輸出什麼內容，再決定寫給誰看。' },
      { p: '複盤的時候先看完播率，再看互動率，最後才看漲粉數，順序不要顛倒。' },
      { p: '評論區裡反覆出現的問題，往往就是下一篇內容最好的選題來源。' },
      { p: '臺灣、香港和澳門的讀者習慣使用繁體字，標點符號也略有不同。' }]] },
  { id: '15-raw-gbk', producer: 'raw', font: 'GB', lang: 'cn', pages: [
    [{ h: '国标扩展编码 GBK-EUC-H' }, ...paragraphs(CN, 3, 5)], [...paragraphs(CN, 12, 5)]] },
  { id: '16-raw-identity-tounicode', producer: 'raw', font: 'ID', lang: 'cn', pages: [
    [{ h: '子集字体与 ToUnicode 映射' }, ...paragraphs(CN, 5, 6)], [...paragraphs(CN, 13, 6)]] },
  { id: '17-raw-en-two-column', producer: 'raw', font: 'F1', lang: 'en', pages: [
    [{ h: 'Hand-Set Two Columns' }, { columns: paragraphs(EN, 2, 8) }], [{ columns: paragraphs(EN, 12, 8) }]] },
  { id: '18-raw-table', producer: 'raw', font: 'SC', lang: 'mixed', pages: [
    [{ h: '表格 Table' }, { table: CN_TABLE }, { p: CN[2] }, { table: MIXED_TABLE }]] },
  { id: '19-raw-header-footer', producer: 'raw', font: 'SU', lang: 'cn', header: '内部培训材料 UTF16', footer: 'cn-page', pages: [
    [{ h: '培训第一课' }, ...paragraphs(CN, 9, 5)], [...paragraphs(CN, 14, 5)], [...paragraphs(CN, 19, 3)]] },
  { id: '20-raw-mixed-cmaps', producer: 'raw', font: 'SC', lang: 'mixed', header: 'Mixed fonts 混合字体', footer: 'en-page', pages: [
    [{ h: 'English and 中文 on one page' }, { p: EN[4] }, { p: CN[4] }, { p: EN[5] }, { p: CN[5] }],
    [{ p: EN[6] }, { p: CN[6] }, { table: EN_TABLE.slice(0, 3) }]] },
];

function footerText(kind, page, total) {
  if (kind === 'cn-page') return `第 ${page} 页`;
  if (kind === 'en-page') return `Page ${page} of ${total}`;
  return null;
}

function blockLines(block) {
  if (block.h !== undefined) return [block.h];
  if (block.p !== undefined) return [block.p];
  if (block.table) return block.table.map((row) => row.join(' '));
  return block.columns.flatMap(blockLines);
}

/** Reference lines of each page, in reading order. */
export function specGold(spec) {
  return spec.pages.map((blocks, index) => {
    const lines = blocks.flatMap(blockLines);
    if (spec.header) lines.unshift(spec.header);
    const footer = footerText(spec.footer, index + 1, spec.pages.length);
    if (footer) lines.push(footer);
    return lines;
  });
}

export { footerText };
