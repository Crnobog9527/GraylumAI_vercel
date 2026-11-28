/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// What the confirmed keywords are about (Owner 2026-11-28, "现在修" H): code-derived, never a model guess. The keywords the coach
// proposes mix the niche ("皮具") with the place, the occasion, the audience and the format ("杭州", "周末", "闺蜜", "手作体验"),
// and a search for those words alone finds anyone in the city or anyone crafting. The niche is what is left of the keywords once
// those generic words are taken out, and when several keywords share a term, that shared term.

/** Words that never name a niche alone: places, times and occasions, audiences, formats and content styles. Longest first. */
const GENERIC_CJK = [
  // Places (mainland provinces and large cities, and where the product's Chinese-speaking users live).
  '北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北',
  '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
  '杭州', '广州', '深圳', '南京', '苏州', '成都', '武汉', '西安', '长沙', '郑州', '青岛', '厦门', '宁波', '无锡', '合肥', '济南', '福州',
  '昆明', '大连', '沈阳', '哈尔滨', '长春', '南昌', '贵阳', '南宁', '石家庄', '太原', '兰州', '海口', '三亚', '佛山', '东莞', '珠海',
  '温州', '绍兴', '嘉兴', '湖州', '金华', '台州', '常州', '南通', '扬州', '徐州', '烟台', '泉州', '台北', '高雄', '台中', '西湖', '萧山',
  '余杭', '滨江', '美国', '加拿大', '澳洲', '澳大利亚', '英国', '日本', '韩国', '新加坡', '马来西亚', '纽约', '洛杉矶', '旧金山', '湾区',
  '硅谷', '西雅图', '波士顿', '芝加哥', '休斯顿', '达拉斯', '奥斯汀', '圣地亚哥', '尔湾', '新泽西', '加州', '德州', '多伦多', '温哥华',
  '悉尼', '墨尔本', '伦敦', '东京', '首尔', '同城', '本地', '附近', '周边', '本市', '国内', '海外', '北美', '全国',
  // Times and occasions.
  '周末', '假期', '节假日', '节日', '寒假', '暑假', '工作日', '下班后', '下班', '每天', '每日', '日常', '今天', '平时', '晚上',
  '去哪玩', '去哪儿', '去哪里', '哪里玩', '好去处', '去处', '打卡', '攻略', '推荐', '探店', '必去', '宝藏', '小众', '网红',
  // Audiences.
  '闺蜜', '朋友', '好友', '情侣', '约会', '亲子', '家庭', '孩子', '宝宝', '宝妈', '女生', '男生', '学生', '大学生', '上班族', '打工人',
  '新手', '小白', '年轻人', '一个人', '一人食', '成人', '儿童',
  // Formats and content styles.
  '体验课', '体验馆', '体验店', '体验', '课程', '教程', '教学', '入门', '培训', '工作室', '手作', '手工', '分享', '记录', '视频', '合集',
  '制作', '自制', '好物', '治愈', '解压', '沉浸式', '生活', '一起', '活动', '玩法', '技巧', '干货', '方法', '零基础', '简单',
].sort((a, b) => b.length - a.length);

const GENERIC_LATIN = new Set([
  'diy', 'class', 'classes', 'workshop', 'workshops', 'tutorial', 'tutorials', 'course', 'courses', 'lesson', 'lessons', 'how',
  'weekend', 'weekends', 'things', 'thing', 'near', 'best', 'ideas', 'idea', 'for', 'and', 'the', 'with', 'beginner', 'beginners',
  'easy', 'simple', 'vlog', 'day', 'daily', 'life', 'local', 'friends', 'couples', 'kids', 'family', 'date', 'fun', 'activities',
  'activity', 'experience', 'handmade', 'craft', 'crafts', 'crafting', 'make', 'making', 'tips', 'guide', 'nyc', 'york', 'new', 'bay',
  'area', 'los', 'angeles', 'san', 'francisco', 'seattle', 'boston', 'chicago', 'houston', 'dallas', 'austin', 'toronto', 'vancouver',
  'london', 'sydney', 'usa', 'america', 'city', 'near', 'you', 'your', 'our',
]);

const CJK = /[㐀-鿿]/;
const DURATION = /\d+\s*(分钟|小时|天|元|块|岁|个月|周)/g;

/** One keyword's subject terms: Chinese runs and Latin phrases with the generic words taken out. */
function subjectsOf(keyword: string): string[] {
  const text = keyword.toLowerCase().replace(/#/g, ' ').replace(DURATION, ' ');
  const terms: string[] = [];
  // Latin words between Chinese runs stay one phrase ("leather wallet"); generic Latin words split it.
  let latin: string[] = [];
  const flushLatin = () => { if (latin.length) terms.push(latin.join(' ')); latin = []; };
  for (const token of text.split(/([㐀-鿿]+)/)) {
    if (!token) continue;
    if (!CJK.test(token)) {
      for (const word of token.split(/[^a-z0-9]+/).filter(Boolean)) {
        if (GENERIC_LATIN.has(word) || word.length < 3 || /^\d+$/.test(word)) flushLatin(); else latin.push(word);
      }
      continue;
    }
    flushLatin();
    terms.push(...cjkSubjects(token));
  }
  flushLatin();
  return terms;
}

/**
 * The parts of one Chinese run that are not generic words. A single character left between generic words stays with the generic
 * word before it (or after it), so a niche named by one character keeps its name ("手工皂": 皂 alone means nothing).
 */
function cjkSubjects(run: string): string[] {
  const parts: Array<{ text: string; generic: boolean }> = [];
  let rest = run;
  while (rest) {
    const generic = GENERIC_CJK.find(word => rest.startsWith(word));
    if (generic) { parts.push({ text: generic, generic: true }); rest = rest.slice(generic.length); continue; }
    const last = parts.at(-1);
    const char = [...rest][0];
    if (last && !last.generic) last.text += char; else parts.push({ text: char, generic: false });
    rest = rest.slice(char.length);
  }
  const subjects: string[] = [];
  parts.forEach((part, index) => {
    if (part.generic) return;
    if ([...part.text].length >= 2) { subjects.push(part.text); return; }
    const before = parts[index - 1], after = parts[index + 1];
    if (before?.generic) subjects.push(before.text + part.text);
    else if (after?.generic) subjects.push(part.text + after.text);
  });
  return subjects;
}

const contains = (keyword: string, term: string) => {
  const text = keyword.toLowerCase().replace(/#/g, ' ');
  return CJK.test(term) ? text.includes(term) : term.split(' ').every(word => new RegExp(`(?<![a-z0-9])${word}`).test(text));
};

/**
 * The niche of the confirmed keywords: the subject terms that two or more keywords share (pay4 2026-11-28: 皮具 in
 * 杭州皮具手作 and 皮具体验课, while 卡包 or 皮革 come from one keyword each); when no term is shared, every subject term.
 * Empty when every keyword is generic: the niche is then unknown and nothing is judged by it.
 */
export function nicheTerms(keywords: readonly string[]): string[] {
  const cleaned = keywords.map(keyword => keyword.trim()).filter(Boolean);
  const terms = [...new Set(cleaned.flatMap(subjectsOf))];
  const shared = terms.filter(term => cleaned.filter(keyword => contains(keyword, term)).length >= 2);
  return shared.length > 0 ? shared : terms;
}
