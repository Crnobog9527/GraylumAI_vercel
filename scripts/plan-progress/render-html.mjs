// 在 Node 里把页面内容渲染成静态 HTML：不执行脚本（例如本地文件预览）也能完整显示。
// 页面里的脚本只负责按状态筛选这类可选交互。所有来自 PR 和规划的文字都经过转义。
import { readFileSync } from 'node:fs';
import { STATUSES } from './derive.mjs';

const COLORS = { 已完成: '--done', 实施中: '--doing', 方案中: '--plan', 被阻塞: '--blocked', 未开始: '--todo', 已关闭: '--closed' };

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const safeUrl = (url) => (/^https:\/\//.test(url ?? '') ? url : '#');

function prLink(pr) {
  const state = pr.state === 'open' ? (pr.draft ? '在途（草稿）' : '在途') : pr.state === 'merged' ? '已合并' : '已关闭未合并';
  const tags = pr.plan ? `${state}，方案` : state;
  const title = `${pr.title}（${tags}）`;
  const href = escapeHtml(safeUrl(pr.url));
  return `<a class="${pr.state}" href="${href}" target="_blank" rel="noopener" title="${escapeHtml(title)}">#${pr.number}</a>`;
}

function dateText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  const local = new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `${local}（北京时间）`;
}

function header(report) {
  const segments = STATUSES.filter((status) => report.counts[status])
    .map((status) => {
      const width = ((report.counts[status] / report.tasks.length) * 100).toFixed(2);
      return `<span style="width:${width}%;background:var(${COLORS[status]})" title="${status} ${report.counts[status]}"></span>`;
    })
    .join('');
  const legend = STATUSES.map(
    (status) =>
      `<button class="chip" type="button" id="filter-${status}" data-status="${status}" aria-pressed="false">` +
      `<span class="dot" style="background:var(${COLORS[status]})"></span>${status} <span class="num">${report.counts[status]}</span></button>`,
  ).join('');
  const label = STATUSES.map((status) => `${status} ${report.counts[status]}`).join('，');
  return `<header>
    <h1>Graylum 施工进度</h1>
    <div class="meta">生成时间 ${dateText(report.generatedAt)} · 任务表来源 <code>${escapeHtml(report.sourceRef)}</code> · 状态由 PR 自动推导，Master Plan 不再手写进度</div>
    <div class="summary"><span class="big">${report.percent}%</span><span>已完成 ${report.counts['已完成']} / ${report.total} 个任务（已关闭的不计入）</span></div>
    <div class="bar" role="img" aria-label="${escapeHtml(label)}">${segments}</div>
    <div class="filters" aria-label="按状态筛选">${legend}</div>
  </header>`;
}

function blockedSummary(report) {
  const blocked = report.tasks.filter((task) => task.status === '被阻塞');
  if (blocked.length === 0) return '';
  const groups = [
    ['owner', '等 Owner 决定或外部事项'],
    ['deps', '等其他任务'],
  ];
  const parts = groups.map(([key, title]) => {
    const items = blocked.filter((task) => task.blockedBy === key);
    if (items.length === 0) return '';
    const lis = items
      .map((task) => {
        const note = key === 'deps' && task.depsNote && task.depsNote !== '—'
          ? `<div class="reason">依赖原文：${escapeHtml(task.depsNote)}</div>` : '';
        return `<li><span class="name">${escapeHtml(task.name)}</span> ${escapeHtml(task.reason)}${note}</li>`;
      })
      .join('');
    return `<div class="label">${title}（${items.length}）</div><ul>${lis}</ul>`;
  });
  return `<section class="extra warn"><h2>卡在哪里</h2>${parts.join('')}</section>`;
}

function card(task, byName) {
  const deps = [
    ...task.deps.map((dep) => [dep, byName.get(dep)?.status === '已完成']),
    ...task.depPrs.map((number) => [`#${number}`, !task.unmetDeps.includes(`#${number}`)]),
  ];
  const depRow = deps.length
    ? `<div class="row"><span class="label">依赖</span>${deps
      .map(([name, met]) => `<span class="dep ${met ? 'ok' : 'no'}">${met ? '✓ ' : ''}${escapeHtml(name)}</span>`)
      .join('')}</div>`
    : '';
  const prs = task.prs.length ? task.prs.map(prLink).join(' ') : '<span class="label">暂无</span>';
  const depsNote = task.depsNote && task.depsNote !== '—'
    ? `<details><summary>依赖原文（含 Owner 和外部前提）</summary><p>${escapeHtml(task.depsNote)}</p></details>` : '';
  return `<article class="card s-${task.status}" data-status="${task.status}">
      <div class="card-top"><span class="name">${escapeHtml(task.name)}</span><span class="pill">${task.status}</span></div>
      ${task.reason ? `<div class="reason">${escapeHtml(task.reason)}</div>` : ''}
      ${depRow}
      ${depsNote}
      <div class="row prs"><span class="label">PR</span>${prs}</div>
      <div class="row"><span class="label">风险 ${escapeHtml(task.risk || '—')} · 规模 ${escapeHtml(task.size || '—')}</span></div>
      <details><summary>任务内容</summary><p>${escapeHtml(task.content)}</p></details>
    </article>`;
}

function phases(report) {
  const byName = new Map(report.tasks.map((task) => [task.name, task]));
  return report.phases
    .map((phase) => {
      const tasks = report.tasks.filter((task) => task.phase === phase);
      const done = tasks.filter((task) => task.status === '已完成').length;
      return `<section class="phase">
    <div class="phase-head"><h2>${escapeHtml(phase)}</h2><span class="num">完成 ${done} / ${tasks.length}</span></div>
    <div class="empty" hidden>这个阶段没有符合筛选条件的任务</div>
    <div class="grid">${tasks.map((task) => card(task, byName)).join('\n')}</div>
  </section>`;
    })
    .join('\n');
}

function unplanned(report) {
  const others = report.unplanned.filter((pr) => !pr.planDoc);
  const docs = report.unplanned.filter((pr) => pr.planDoc);
  const items = others.map((pr) => `<li>${prLink(pr)} ${escapeHtml(pr.title)}</li>`).join('');
  const docLine = docs.length ? `<p>规划文档：${docs.map(prLink).join(' ')}</p>` : '';
  return `<section class="extra"><h2>计划外工作</h2>
    <div class="meta">${escapeHtml(report.since)} 起合并进 staging、标题和正文都没有对上任务名的 PR：${others.length} 个；规划文档同步 ${docs.length} 个</div>
    <details><summary>展开列表</summary><ul>${items}</ul>${docLine}</details></section>`;
}

function warnings(report) {
  if (report.warnings.length === 0) return '';
  const items = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  return `<section class="extra warn"><h2>需要核对</h2><ul>${items}</ul></section>`;
}

export function renderHtml(report, templatePath) {
  const template = readFileSync(templatePath, 'utf8');
  if (!template.includes('__PLAN_PROGRESS_BODY__')) throw new Error('页面模板缺少内容占位符');
  const body = [header(report), blockedSummary(report), `<main class="phases">${phases(report)}</main>`, unplanned(report), warnings(report)]
    .filter(Boolean)
    .join('\n');
  return template.replace('__PLAN_PROGRESS_BODY__', () => body);
}
