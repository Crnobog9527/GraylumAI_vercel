// 把任务定义和 PR 列表合成每个任务的阶段。纯函数，便于测试。
import { findTaskNames, plainText } from './parse-plan.mjs';

export const STATUSES = ['已完成', '实施中', '方案中', '被阻塞', '未开始', '已关闭'];

const TOKEN_BOUNDARY = '[A-Za-z0-9-]';
const PLAN_DOC_TITLE = /^docs\((?:plan|master-plan)\)/i;

// 标题里的规范任务名（大写原样），或约定式标题 type(scope) 的 scope 与任务名一致（不区分大小写）。
export function namesInTitle(title, names) {
  const found = new Set(findTaskNames(title, names));
  const scope = title.match(/^[a-z]+\(([^)]+)\)!?:/i);
  if (scope) {
    for (const part of scope[1].split(/[,，\s]+/)) {
      const upper = part.toUpperCase();
      if (names.includes(upper)) found.add(upper);
    }
  }
  return [...found];
}

// 正文里单独一行"任务：X、Y"或"Task: X"。
export function namesInBody(body, names) {
  const found = new Set();
  for (const match of (body ?? '').matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:任务|Task)(?:\*\*)?\s*[:：]\s*(.+)$/gim)) {
    for (const name of names) {
      const pattern = new RegExp(`(?<!${TOKEN_BOUNDARY})${name}(?!${TOKEN_BOUNDARY})`);
      if (pattern.test(match[1])) found.add(name);
    }
  }
  return [...found];
}

// 只含方案的 PR："仅方案"，或 docs 类型且标题写了"方案"。实施 PR 标题里提到"方案待审"之类不算。
export function isPlanTitle(title) {
  return /仅方案/.test(title) || (/^docs(\(|:)/i.test(title) && /方案/.test(title));
}

function prState(pr) {
  if (pr.mergedAt || pr.state === 'MERGED') return 'merged';
  if (pr.state === 'OPEN') return 'open';
  return 'closed';
}

function toLink(pr, plan) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: prState(pr),
    draft: Boolean(pr.isDraft),
    mergedAt: pr.mergedAt ?? null,
    plan,
  };
}

export function derive({ plan, prs, since, generatedAt, sourceRef }) {
  const names = plan.tasks.map((task) => task.name).sort((a, b) => b.length - a.length);
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const warnings = [];
  const links = new Map(plan.tasks.map((task) => [task.name, new Map()]));
  const matched = new Set();

  for (const pr of prs) {
    const hits = new Set([...namesInTitle(pr.title, names), ...namesInBody(pr.body, names)]);
    for (const name of hits) {
      links.get(name).set(pr.number, toLink(pr, isPlanTitle(pr.title)));
      matched.add(pr.number);
    }
  }
  for (const [name, refs] of plan.history) {
    for (const ref of refs) {
      const pr = byNumber.get(ref.number);
      if (!pr) {
        warnings.push(`历史 PR 对照里 ${name} 的 #${ref.number} 在 GitHub 上没有读到`);
        continue;
      }
      links.get(name).set(pr.number, toLink(pr, ref.plan || isPlanTitle(pr.title)));
      matched.add(pr.number);
    }
  }

  const tasks = plan.tasks.map((task) => ({ ...task, prs: [...links.get(task.name).values()] }));
  const byName = new Map(tasks.map((task) => [task.name, task]));
  const done = (name) => byName.get(name)?.annotation?.kind === '完成';

  for (const task of tasks) {
    task.prs.sort((a, b) => a.number - b.number);
    const live = task.prs.filter((pr) => pr.state !== 'closed');
    const open = live.filter((pr) => pr.state === 'open');
    const unmetTasks = task.deps.filter((name) => !done(name));
    const unmetPrs = task.depPrs.filter((number) => prState(byNumber.get(number) ?? {}) !== 'merged');
    task.unmetDeps = [...unmetTasks, ...unmetPrs.map((number) => `#${number}`)];
    task.openCount = open.length;
    task.mergedCount = live.length - open.length;
    const note = task.annotation;
    if (note?.kind === '完成') {
      task.status = '已完成';
      if (open.length > 0) warnings.push(`${task.name} 标为完成，但还有在途 PR：${open.map((pr) => `#${pr.number}`).join('、')}`);
    } else if (note?.kind === '关闭') {
      task.status = '已关闭';
      task.reason = note.reason;
    } else if (note?.kind === '阻塞') {
      task.status = '被阻塞';
      task.reason = note.reason;
    } else if (live.some((pr) => !pr.plan)) {
      task.status = '实施中';
      if (open.length === 0) task.reason = '已有合并的实施 PR，目前没有在途 PR';
    } else if (live.length > 0) {
      task.status = '方案中';
    } else if (task.unmetDeps.length > 0) {
      task.status = '被阻塞';
      task.blockedBy = 'deps';
    } else {
      task.status = '未开始';
    }
  }

  // 第二遍：所有状态都定了以后，写明卡在哪个依赖、那个依赖现在处于什么阶段。
  for (const task of tasks) {
    if (task.annotation?.kind === '阻塞') task.blockedBy = 'owner';
    if (task.blockedBy !== 'deps') continue;
    const parts = task.unmetDeps.map((dep) => {
      if (dep.startsWith('#')) return `${dep}（未合并）`;
      const target = byName.get(dep);
      return target ? `${dep}（${target.status}）` : dep;
    });
    task.reason = `等依赖完成：${parts.join('、')}`;
  }

  const sinceTime = since ? Date.parse(`${since}T00:00:00Z`) : 0;
  const unplanned = prs
    .filter((pr) => prState(pr) === 'merged' && pr.baseRefName === 'staging' && !matched.has(pr.number))
    .filter((pr) => Date.parse(pr.mergedAt) >= sinceTime)
    .map((pr) => ({ ...toLink(pr, false), planDoc: PLAN_DOC_TITLE.test(pr.title) }))
    .sort((a, b) => b.number - a.number);

  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const task of tasks) counts[task.status] += 1;
  const total = tasks.length - counts['已关闭'];
  return {
    generatedAt,
    sourceRef,
    since,
    phases: plan.phases,
    counts,
    total,
    percent: total === 0 ? 0 : Math.round((counts['已完成'] / total) * 100),
    tasks: tasks.map(({ depsText, ...task }) => ({ ...task, depsNote: plainText(depsText) })),
    unplanned,
    warnings,
  };
}
