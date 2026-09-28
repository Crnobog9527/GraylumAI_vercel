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
