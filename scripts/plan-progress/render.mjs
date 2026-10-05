// 终端 Markdown。静态页面见 render-html.mjs。
import { STATUSES } from './derive.mjs';

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function prList(prs) {
  return prs
    .filter((pr) => pr.state !== 'closed')
    .map((pr) => `#${pr.number}${pr.state === 'open' ? '（在途）' : ''}${pr.plan ? '（方案）' : ''}`)
    .join(' ');
}

export function renderMarkdown(report) {
  const out = [];
  out.push(`# Master Plan 进度（生成于 ${report.generatedAt}，任务表来源 ${report.sourceRef}）`, '');
  out.push(`完成 ${report.counts['已完成']} / ${report.total}（${report.percent}%，已关闭的任务不计入）`, '');
  out.push(STATUSES.map((status) => `${status} ${report.counts[status]}`).join(' · '), '');
  if (report.roadmap) {
    const { roadmap } = report;
    const current = roadmap.stations.find((station) => station.id === roadmap.currentId);
    out.push(`路线图：主线 ${roadmap.mainCount} 站，已到站 ${roadmap.doneCount} 站；现在在"${current ? current.name : '正式上线'}"`, '');
  }
  for (const phase of report.phases) {
    out.push(`## ${phase}`, '', '| 任务 | 状态 | 说明 | PR |', '| --- | --- | --- | --- |');
    for (const task of report.tasks.filter((item) => item.phase === phase)) {
      const settled = task.status === '已完成' || task.status === '已关闭';
      const note = task.reason || (!settled && task.unmetDeps.length ? `依赖未完成：${task.unmetDeps.join('、')}` : '');
      out.push(`| ${task.name} | ${task.status} | ${cell(note)} | ${prList(task.prs)} |`);
    }
    out.push('');
  }
  const planDocs = report.unplanned.filter((pr) => pr.planDoc);
  const others = report.unplanned.filter((pr) => !pr.planDoc);
  out.push(`## 计划外工作（${report.since} 起合并、没有对上任务名的 PR：${others.length} 个，另有规划文档 ${planDocs.length} 个）`, '');
  for (const pr of others) out.push(`- #${pr.number} ${pr.title}`);
  if (planDocs.length) out.push('', `规划文档：${planDocs.map((pr) => `#${pr.number}`).join(' ')}`);
  if (report.warnings.length) {
    out.push('', '## 需要核对', '');
    for (const warning of report.warnings) out.push(`- ${warning}`);
  }
  return `${out.join('\n')}\n`;
}
