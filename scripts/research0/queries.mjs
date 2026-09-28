// The fixed RESEARCH-0 query set. Only well-known institutional public
// accounts and generic keywords; no private individuals and no user data.
// `webQuery` is what a general web-search vendor receives for the same need.

export const QUERIES = [
  {
    id: 'Q01', region: 'cn', platform: 'web', type: 'keyword',
    keyword: '短视频创作者 变现 趋势 2026',
    webQuery: '短视频创作者 变现 趋势 2026',
  },
  {
    id: 'Q02', region: 'cn', platform: 'douyin', type: 'keyword',
    keyword: '露营装备',
    webQuery: '抖音 露营装备 视频',
  },
  {
    id: 'Q03', region: 'cn', platform: 'xiaohongshu', type: 'keyword',
    keyword: '极简护肤',
    webQuery: '小红书 极简护肤 笔记',
  },
  {
    id: 'Q04', region: 'cn', platform: 'bilibili', type: 'profile',
    account: { name: '央视新闻', bilibiliMid: '456664753' },
    webQuery: '央视新闻 哔哩哔哩 个人空间 粉丝',
  },
  {
    id: 'Q05', region: 'cn', platform: 'weibo', type: 'posts',
    account: { name: '人民日报', weiboUid: '2803301701' },
    webQuery: '人民日报 微博 最新',
  },
  {
    id: 'Q06', region: 'global', platform: 'tiktok', type: 'profile',
    account: { name: 'National Geographic', handle: 'natgeo' },
    webQuery: 'National Geographic TikTok @natgeo followers',
  },
  {
    id: 'Q07', region: 'global', platform: 'tiktok', type: 'keyword',
    keyword: 'camping gear',
    webQuery: 'TikTok camping gear videos',
  },
  {
    id: 'Q08', region: 'global', platform: 'youtube', type: 'posts',
    account: { name: 'NASA', handle: 'NASA', youtubeChannelId: 'UCLA_DiR1FfKNvjuUpBHmylQ' },
    webQuery: 'NASA YouTube channel latest videos',
  },
  {
    id: 'Q09', region: 'global', platform: 'x', type: 'profile',
    account: { name: 'NASA', handle: 'NASA' },
    webQuery: 'NASA X twitter @NASA profile followers',
  },
  {
    id: 'Q10', region: 'global', platform: 'instagram', type: 'posts',
    account: { name: 'National Geographic', handle: 'natgeo' },
    webQuery: 'National Geographic Instagram @natgeo latest posts',
  },
];

// Supplemental round (Owner, 2026-09-28): TikHub after top-up covers the query
// types the first round did not reach, plus public-page fetches for Firecrawl.
export const SUPPLEMENTAL_QUERIES = [
  { id: 'S01', region: 'cn', platform: 'douyin', type: 'keyword', keyword: '露营装备' },
  { id: 'S02', region: 'global', platform: 'tiktok', type: 'posts', account: { name: 'National Geographic', handle: 'natgeo' } },
  { id: 'S03', region: 'global', platform: 'youtube', type: 'profile', account: { name: 'NASA', youtubeChannelId: 'UCLA_DiR1FfKNvjuUpBHmylQ' } },
  { id: 'S04', region: 'global', platform: 'youtube', type: 'keyword', keyword: 'camping gear' },
  { id: 'S05', region: 'global', platform: 'instagram', type: 'profile', account: { name: 'National Geographic', handle: 'natgeo' } },
  { id: 'S06', region: 'global', platform: 'instagram', type: 'keyword', keyword: 'camping gear' },
  { id: 'S07', region: 'global', platform: 'x', type: 'posts', account: { name: 'NASA', handle: 'NASA' } },
  { id: 'S08', region: 'global', platform: 'x', type: 'keyword', keyword: 'camping gear' },
  { id: 'S09', region: 'global', platform: 'instagram', type: 'posts', account: { name: 'National Geographic', handle: 'natgeo' } },
  { id: 'F01', region: 'cn', platform: 'web', type: 'fetch', url: 'https://www.gov.cn/' },
  { id: 'F02', region: 'global', platform: 'web', type: 'fetch', url: 'https://en.wikipedia.org/wiki/Creator_economy' },
  { id: 'F03', region: 'global', platform: 'web', type: 'fetch', url: 'https://www.nasa.gov/news/' },
];

// Chinese web-search quality round (Owner, 2026-09-28): typical questions of
// Chinese creators, plus two freshness probes. Generic topics only.
export const ZH_QUERIES = [
  '小红书 爆款笔记 标题 技巧 2026', '抖音 推荐算法 最新变化', '视频号 直播带货 2026 趋势', 'B站 UP主 涨粉 方法',
  '公众号 打开率 下降 原因', '知识付费 课程 定价 策略', '短剧 出海 市场规模 2026', '露营经济 消费趋势 报告',
  '国潮品牌 营销案例', 'AI数字人 直播带货 效果', '小红书 KOC 种草 投放 成本', '抖音电商 2026 上半年 GMV',
  '淄博烧烤 爆火 原因 分析', '2026年9月 热点事件', '华为 新品发布会 2026', '新能源汽车 9月 销量 排行',
  '中国网络视听发展研究报告 2026', '微信视频号 创作者 分成 政策', '快手 磁力金牛 投放 教程', '母婴博主 变现 方式',
].map((keyword, index) => ({
  id: `C${String(index + 1).padStart(2, '0')}`, region: 'cn', platform: 'web', type: 'keyword', keyword, webQuery: keyword,
}));
