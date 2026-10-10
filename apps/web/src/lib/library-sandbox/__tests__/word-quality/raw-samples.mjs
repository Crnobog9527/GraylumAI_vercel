/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Hand-written OOXML for constructs Word produces but LibreOffice/textutil do not: split runs,
// tracked changes, fields, content controls, rare characters, Chinese style names and pictures.
// `lines` is what a reader sees in Word's final (changes accepted) view.
import { esc, footnoteRef, para, picture, run, table, TINY_PNG, W_NS, XML_HEAD } from '../docx-fixture.ts';

const heading = (level, inner, style = `Heading${level}`) =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${inner}</w:p>`;
const bold = (text) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const field = (instruction, result) => '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
  + `<w:r><w:instrText xml:space="preserve"> ${esc(instruction)} </w:instrText></w:r>`
  + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

const CHINESE_STYLES = `${XML_HEAD}<w:styles xmlns:w="${W_NS}">`
  + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="a3"><w:name w:val="标题 3"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="a5"><w:name w:val="Title"/></w:style></w:styles>';

/** @type {{ id: string, parts: object, lines: string[], headings: { level: number, text: string }[] }[]} */
export const RAW_SAMPLES = [
  {
    id: '16-raw-split-runs',
    parts: { body: [
      heading(1, `${run('账号')}<w:proofErr w:type="spellStart"/>${bold('定位')}<w:proofErr w:type="spellEnd"/>`
        + `<w:bookmarkStart w:id="0" w:name="_Toc1"/>${run('复盘')}<w:bookmarkEnd w:id="0"/>`),
      `<w:p>${run('完播率')}${bold('38%')}${run('，')}${run('互动率 ')}<w:r><w:rPr><w:i/></w:rPr><w:t>5.4%</w:t></w:r>${run('。')}</w:p>`,
      heading(2, `${run('Engage')}${bold('ment')}${run(' Review')}`),
      `<w:p>${run('Line one')}<w:r><w:br/></w:r>${run('Line two')}<w:r><w:tab/></w:r>${run('after tab')}</w:p>`,
      `<w:p>${run('Smart')}<w:smartTag w:uri="urn:x" w:element="place">${run('Tag')}</w:smartTag>${run(' text.')}</w:p>`,
    ].join('') },
    lines: ['账号定位复盘', '完播率38%，互动率 5.4%。', 'Engagement Review', 'Line one', 'Line two\tafter tab', 'SmartTag text.'],
    headings: [{ level: 1, text: '账号定位复盘' }, { level: 2, text: 'Engagement Review' }],
  },
  {
    id: '17-raw-tracked-changes',
    parts: { body: [
      heading(1, run('修订稿 Revised Draft')),
      `<w:p>${run('发布时间')}<w:ins w:id="1" w:author="A" w:date="2026-10-01T00:00:00Z">${run('固定在每周三晚上')}</w:ins>`
        + `<w:del w:id="2" w:author="A" w:date="2026-10-01T00:00:00Z"><w:r><w:delText>随意安排</w:delText></w:r></w:del>${run('。')}</w:p>`,
      `<w:p>${run('Keep ')}<w:del w:id="3" w:author="A" w:date="2026-10-01T00:00:00Z"><w:r><w:delText>five </w:delText></w:r></w:del>`
        + `<w:ins w:id="4" w:author="A" w:date="2026-10-01T00:00:00Z">${run('one ')}</w:ins>${run('trend at a time.')}</w:p>`,
    ].join('') },
    lines: ['修订稿 Revised Draft', '发布时间固定在每周三晚上。', 'Keep one trend at a time.'],
    headings: [{ level: 1, text: '修订稿 Revised Draft' }],
  },
  {
    id: '18-raw-fields-controls',
    parts: { body: [
      heading(1, run('合作报价单')),
      `<w:sdt><w:sdtPr><w:alias w:val="客户"/></w:sdtPr><w:sdtContent>${para('客户：示例品牌')}</w:sdtContent></w:sdt>`,
      `<w:p>${run('日期：')}<w:fldSimple w:instr=" DATE \\@ &quot;yyyy-MM-dd&quot; ">${run('2026-10-10')}</w:fldSimple></w:p>`,
      `<w:p>${run('报价说明见')}${field('HYPERLINK "https://example.invalid/never"', '报价规则')}${run('。')}</w:p>`,
      `<w:p>${run('联系人：')}<w:sdt><w:sdtPr/><w:sdtContent>${run('运营负责人')}</w:sdtContent></w:sdt></w:p>`,
      table([['项目', '单价'], ['图文', '3000'], ['视频', '8000']]),
    ].join('') },
    lines: ['合作报价单', '客户：示例品牌', '日期：2026-10-10', '报价说明见报价规则。', '联系人：运营负责人', '项目\t单价', '图文\t3000', '视频\t8000'],
    headings: [{ level: 1, text: '合作报价单' }],
  },
  {
    id: '19-raw-rare-characters',
    parts: { body: [
      heading(1, run('字符覆盖 Characters')),
      para('生僻字：𠀋𡈽𪚥龘；繁體：資料庫與語料庫。'),
      para('标点：「引号」『书名』——破折号……省略号（全角）！？'),
      para('Emoji 📈🎬✨ and symbols ≥ ≤ ± × ÷ € ¥ ©.'),
      para('日本語のカタカナ、한국어 문장, Tiếng Việt có dấu.'),
      `<w:p>${run('不换行')}<w:r><w:t xml:space="preserve"> 空格</w:t></w:r>${run(' and   spaces')}</w:p>`,
    ].join('') },
    lines: ['字符覆盖 Characters', '生僻字：𠀋𡈽𪚥龘；繁體：資料庫與語料庫。', '标点：「引号」『书名』——破折号……省略号（全角）！？',
      'Emoji 📈🎬✨ and symbols ≥ ≤ ± × ÷ € ¥ ©.', '日本語のカタカナ、한국어 문장, Tiếng Việt có dấu.', '不换行 空格 and   spaces'],
    headings: [{ level: 1, text: '字符覆盖 Characters' }],
  },
  {
    id: '20-raw-chinese-styles-images',
    parts: {
      styles: CHINESE_STYLES,
      header: '灰度映画 示例', firstHeader: '灰度映画 示例', footer: '仅供测试',
      footnotes: ['截图来自示例账号。'],
      images: [TINY_PNG, TINY_PNG],
      body: [
        heading(1, run('年度总结'), 'a5'),
        heading(1, run('第一章 数据'), '1'),
        `<w:p>${run('上图为播放量走势')}${footnoteRef(1)}${run('。')}</w:p>`,
        `<w:p>${picture(1)}</w:p>`,
        heading(2, run('1.1 互动'), '2'),
        `<w:p>${run('评论区截图：')}${picture(2)}</w:p>`,
        heading(3, run('1.1.1 细节'), 'a3'),
        para('收藏率高于平均水平。'),
      ].join(''),
    },
    lines: ['灰度映画 示例', '年度总结', '第一章 数据', '上图为播放量走势[1]。', '1.1 互动', '评论区截图：', '1.1.1 细节',
      '收藏率高于平均水平。', '[1] 截图来自示例账号。', '仅供测试'],
    headings: [{ level: 1, text: '年度总结' }, { level: 1, text: '第一章 数据' }, { level: 2, text: '1.1 互动' }, { level: 3, text: '1.1.1 细节' }],
  },
];
