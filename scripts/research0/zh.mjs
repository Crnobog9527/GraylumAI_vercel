// Chinese-query summary for web search results: how much of what comes back
// is Chinese, from Chinese sites, dated and recent. Only aggregate numbers;
// no titles or excerpts are printed (the repository is public).

const CJK = /[㐀-鿿]/;
const CN_SITES = [
  'qq', '163', 'sina', 'sohu', 'baidu', 'zhihu', 'bilibili', 'douyin', 'xiaohongshu', 'weibo', '36kr', 'ifeng', 'thepaper',
  'jiemian', 'huxiu', 'sspai', 'toutiao', 'kuaishou', 'people', 'xinhuanet', 'cctv', 'chinanews', 'caixin', 'yicai', 'cls',
  'jiqizhixin', 'woshipm', 'iresearch', 'qianzhan', 'cnki', 'csdn', 'aliyun', 'tencent',
];
const CN_HOST = new RegExp(`(\\.cn$|(^|\\.)(${CN_SITES.join('|')})\\.com$)`);

function host(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function zhStats(items) {
  const total = items.length;
  const share = count => (total === 0 ? null : Math.round((count / total) * 100));
  const dated = items.filter(item => typeof item.publishedAt === 'string');
  return {
    results: total,
    chineseTitlePct: share(items.filter(item => CJK.test(item.title ?? '')).length),
    chineseSitePct: share(items.filter(item => CN_HOST.test(host(item.url))).length),
    datedPct: share(dated.length),
    newest: dated.map(item => item.publishedAt).sort().at(-1) ?? null,
    distinctSites: new Set(items.map(item => host(item.url)).filter(Boolean)).size,
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Days between the newest dated result of a query and the report time; null when nothing is dated. */
export function newestAgeDays(stats, reportTime) {
  if (!stats.newest) return null;
  return Math.max(0, Math.floor((Date.parse(reportTime) - Date.parse(stats.newest)) / 86_400_000));
}

/** One row per vendor: averages over its successful queries, plus how many succeeded. */
export function formatZhTable(report) {
  const lines = ['| 供应商 | 成功查询 | 平均结果数 | 中文标题占比 | 中国网站占比 | 带发布日期 | 平均不同网站数 | 最新结果距今（中位数，天） | 响应时间中位数 |',
    '|---|---|---|---|---|---|---|---|---|'];
  for (const vendor of report.vendors) {
    const ok = vendor.queries.filter(query => query.status === 'OK' && Array.isArray(query.items));
    const stats = ok.map(query => zhStats(query.items));
    const mean = key => {
      const values = stats.map(stat => stat[key]).filter(Number.isFinite);
      return values.length === 0 ? '未提供' : `${Math.round(values.reduce((a, b) => a + b, 0) / values.length)}`;
    };
    const age = median(stats.map(stat => newestAgeDays(stat, report.generatedAt)));
    const latency = median(ok.map(query => query.latencyMs));
    lines.push(`| ${vendor.label} | ${ok.length}/${vendor.queries.length} | ${mean('results')} | ${mean('chineseTitlePct')}% | ${mean('chineseSitePct')}% | `
      + `${mean('datedPct')}% | ${mean('distinctSites')} | ${age === null ? '未提供' : age} | ${latency === null ? '未提供' : `${latency} ms`} |`);
  }
  return lines.join('\n');
}
