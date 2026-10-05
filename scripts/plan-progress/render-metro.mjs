// "上线路线图"：给 Owner 看的地铁线路图。静态 HTML，不执行脚本也能完整显示；点开站点用原生 details。
import { escapeHtml } from './render-html.mjs';

const safeUrl = (url) => (/^https:\/\//.test(url ?? '') ? url : '#');

function badge(station, isCurrent) {
  if (station.note) return '<span class="badge b-later">上线后再做</span>';
  if (station.afterLaunch && station.status !== 'done') return '<span class="badge b-later">上线后再做</span>';
  if (station.status === 'done') return '<span class="badge b-done">已到站</span>';
  if (isCurrent) return '<span class="badge b-now">正在做 · 现在在这一站</span>';
  if (station.status === 'doing') return '<span class="badge b-doing">也在做</span>';
  return '<span class="badge b-todo">还没到</span>';
}

function notes(station) {
  const lines = [];
  if (station.note) lines.push(`<span class="note">${escapeHtml(station.note)}</span>`);
  for (const wait of station.waits) lines.push(`<span class="note n-ask"><b>等你</b>${escapeHtml(wait.replace(/^等你[：:]\s*/, ''))}</span>`);
  // 只写最晚完成的那一个前置站：它到站了，这一站才能开始。
  if (station.after.length) lines.push(`<span class="note">排在「${escapeHtml(station.after[station.after.length - 1])}」之后</span>`);
  for (const item of station.shortOf) lines.push(`<span class="note n-short">还差：${escapeHtml(item)}</span>`);
  return lines.join('');
}

const ORDER = { 等你: 0, 在做: 1, 在出方案: 1, 还没开始: 2, 做完了: 3, 不做了: 4 };
const TAG_CLASS = { 等你: 'ask', 在做: 'doing', 在出方案: 'doing', 还没开始: 'todo', 做完了: 'done', 不做了: 'closed' };

// 每个任务一张小卡片：状态标签、一句话、必要时一行小字；改动记录收在卡片右下角的小折叠里。
function taskCard(task) {
  const prs = task.prs.filter((pr) => pr.state !== 'closed').sort((a, b) => a.number - b.number);
  const prBlock = prs.length
    ? `<details class="tprs"><summary>相关改动（${prs.length}）</summary><ul>${prs
      .map((pr) => `<li><a href="${escapeHtml(safeUrl(pr.url))}" target="_blank" rel="noopener">#${pr.number}</a> ${escapeHtml(pr.title)}</li>`)
      .join('')}</ul></details>`
    : '';
  const sub = task.sub ? `<p class="tsub">${escapeHtml(task.sub)}</p>` : '';
  return `<li class="tcard t-${TAG_CLASS[task.word] ?? 'todo'}">
        <span class="tag">${escapeHtml(task.word)}</span>
        <div class="tbody"><p class="ttext">${escapeHtml(task.plain)}</p>${sub}</div>
        ${prBlock}
      </li>`;
}

// 先放等你、在做、还没开始；做完了和不做了的收进"已完成"小折叠。
function taskList(station) {
  const sorted = [...station.tasks].sort((a, b) => (ORDER[a.word] ?? 9) - (ORDER[b.word] ?? 9));
  const open = sorted.filter((task) => (ORDER[task.word] ?? 9) < 3);
  const finished = sorted.filter((task) => (ORDER[task.word] ?? 9) >= 3);
  const openList = open.length ? `<ul class="tcards">${open.map(taskCard).join('')}</ul>` : '';
  const doneList = finished.length
    ? `<details class="tdone"><summary>已完成（${finished.length} 项）</summary><ul class="tcards">${finished.map(taskCard).join('')}</ul></details>`
    : '';
  return openList + doneList;
}

function classes(base, station, isCurrent) {
  const extra = [station.afterLaunch && 'later', isCurrent && 'current', station.terminal && 'terminal'].filter(Boolean);
  return [base, `st-${station.status}`, ...extra].join(' ');
}

function stationItem(station, number, currentId) {
  const isCurrent = station.id === currentId;
  const cls = classes('station', station, isCurrent);
  // 上线后的站只显示站名，用途放进点开以后，让整页更短。
  const plain = station.afterLaunch ? '' : `<span class="splain">${escapeHtml(station.plain)}</span>`;
  const laterPlain = station.afterLaunch ? `<p class="splain">${escapeHtml(station.plain)}</p>` : '';
  const label = station.terminal ? `终点站 · ${escapeHtml(station.name)}` : escapeHtml(station.name);
  return `<li class="${cls}" id="station-${escapeHtml(station.id)}">
    <span class="dot" aria-hidden="true"></span>
    <details>
      <summary>
        <span class="sline"><span class="snum">${number}</span><span class="sname">${label}</span>${badge(station, isCurrent)}${plain}</span>
        ${notes(station)}
      </summary>
      <div class="inner">${laterPlain}${taskList(station)}</div>
    </details>
  </li>`;
}

function strip(roadmap) {
  const items = [];
  const laterCount = roadmap.stations.filter((station) => station.afterLaunch).length;
  roadmap.stations.forEach((station, index) => {
    if (station.afterLaunch) return;
    const cls = classes('mini', station, station.id === roadmap.currentId);
    const label = `<span class="mlabel">${index + 1}. ${escapeHtml(station.name)}</span>`;
    items.push(`<li class="${cls}"><a href="#station-${escapeHtml(station.id)}"><span class="mdot"></span>${label}</a></li>`);
  });
  if (laterCount) items.push(`<li class="mini divider later" aria-hidden="true"><span>上线后还有 ${laterCount} 站</span></li>`);
  return `<ol class="strip" aria-label="整条路线一览">${items.join('')}</ol>`;
}

function dateText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return `${new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）`;
}

export function renderMetro(roadmap, generatedAt) {
  const current = roadmap.stations.find((station) => station.id === roadmap.currentId);
  const now = current
    ? `现在走到第 ${current.index + 1} 站：<strong>${escapeHtml(current.name)}</strong>`
    : '主线已全部到站：<strong>正式上线</strong>';
  const asks = roadmap.stations.filter((station) => !station.afterLaunch).flatMap((station) => station.waits);
  const askBlock = asks.length
    ? `<div class="asks"><b>上线前有 ${asks.length} 件事等你：</b><ul>${asks
      .map((ask) => `<li>${escapeHtml(ask.replace(/^等你[：:]\s*/, ''))}</li>`)
      .join('')}</ul></div>`
    : '';
  const main = [];
  const later = [];
  roadmap.stations.forEach((station, index) => {
    (station.afterLaunch ? later : main).push(stationItem(station, index + 1, roadmap.currentId));
  });
  // 上线后的站默认收起，主线保持在一屏多一点。
  const laterBlock = later.length
    ? `<details class="later-block"><summary>正式上线以后再做（${later.length} 站）</summary><ol class="line">${later.join('\n')}</ol></details>`
    : '';
  return `<section class="roadmap">
  <div class="hero">
    <h1>Graylum 上线路线图</h1>
    <p class="now">${now}</p>
    <p class="sub">主线一共 ${roadmap.mainCount} 站，已到站 ${roadmap.doneCount} 站，终点是“正式上线”。
      点开任意一站能看到里面的小任务。更新于 ${dateText(generatedAt)}</p>
    ${askBlock}
  </div>
  ${strip(roadmap)}
  <ol class="line">${main.join('\n')}</ol>
  ${laterBlock}
</section>`;
}
